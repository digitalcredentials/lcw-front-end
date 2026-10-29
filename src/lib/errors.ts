// Requests fail with whatever threw: the WAS client (a WasError subclass
// carrying `status` and `type`), the signed-request HTTP client (`status` on
// the error itself), the browser's fetch (a TypeError), or a plain Error.
// None of those messages mean anything to a learner, and some carry a URL or a
// status code. So every failure shown in the wallet is translated here into a
// sentence saying what failed and what the person can do, with the technical
// text kept for the console and a details toggle. Modelled on
// batch-issuer-ui's describeFailure (src/lib/errors.ts there).

// What the person was doing when the request failed; the sentence shown names
// the action.
export type WalletAction =
  | 'load-spaces'
  | 'load-collections'
  | 'load-credentials'
  | 'open'
  | 'delete'
  | 'restore'
  | 'move'
  | 'upload'
  | 'create-collection'
  | 'save-description'
  | 'create-space'

const FAILED: Record<WalletAction, string> = {
  'load-spaces': "We couldn't load your spaces.",
  'load-collections': "We couldn't load your collections.",
  'load-credentials': "We couldn't load this collection.",
  open: "We couldn't open this credential.",
  delete: "We couldn't delete this credential.",
  restore: "We couldn't restore this credential.",
  move: "We couldn't move this credential.",
  upload: "We couldn't add this credential.",
  'create-collection': "We couldn't create the collection.",
  'save-description': "We couldn't save the description.",
  'create-space': "We couldn't create the space.",
}

// A failure as the wallet shows it: the sentence, and the technical text
// behind it for whoever is debugging.
export interface Failure {
  text: string
  detail?: string
}

// Thrown when the WAS client answers a credential's read with null: it isn't
// there, or isn't visible to this session (the server answers both as 404).
export class CredentialMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialMissingError'
  }
}

// Thrown when a new collection's id is already taken by a collection the
// wallet cannot reuse.
export class CollectionExistsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectionExistsError'
  }
}

// The status, name, message and problem type as read off an unknown error:
// the signed-request HTTP client carries the server's problem body on
// `data`. Any of it may be missing, so read it all defensively.
function readFailure(error: unknown): { status?: number; name?: string; message?: string; type?: string } {
  if (typeof error !== 'object' || error === null) {
    return {}
  }
  const { status, name, message, type, data } = error as {
    status?: unknown
    name?: unknown
    message?: unknown
    type?: unknown
    data?: unknown
  }
  const body = typeof data === 'object' && data !== null ? (data as { type?: unknown }) : undefined
  const problemType = typeof type === 'string' ? type : typeof body?.type === 'string' ? body.type : undefined
  return {
    status: typeof status === 'number' ? status : undefined,
    name: typeof name === 'string' ? name : undefined,
    message: typeof message === 'string' ? message : undefined,
    type: problemType,
  }
}

// No session: the wallet's own code throws Error('UNAUTHORIZED') when it
// finds none. Retrying cannot help; signing in can, so handleError sends the
// person to sign in. A session the storage server no longer accepts can't be
// told apart here: the server answers it as not found (404) or, for a
// listing, as an empty list.
export function isSessionEnded(error: unknown): boolean {
  return readFailure(error).message === 'UNAUTHORIZED'
}

// No answer from the server at all: the browser's fetch failure ("Failed to
// fetch", Safari's "Load failed", Firefox's "NetworkError…"), which the WAS
// client wraps in a status-less WasError keeping its message, or the HTTP
// client's timeout. Matched by message, not by the TypeError class, which
// the wallet's own bugs throw too. The browser reports a server error sent
// without CORS headers the same way, so the sentence doesn't blame the
// connection alone.
function isUnreachable(error: unknown): boolean {
  const { status, message } = readFailure(error)
  return status === undefined && /Failed to fetch|Load failed|NetworkError|timed out/i.test(message ?? '')
}

// A server fault (5xx): the storage server answered, but with an error.
function isServerFault(error: unknown): boolean {
  const { status, name } = readFailure(error)
  return (status !== undefined && status >= 500) || name === 'WasServerError'
}

// The technical text behind a failure, for the details toggle.
function technicalDetail(error: unknown): string {
  const { status, name, message } = readFailure(error)
  const text = message ?? String(error)
  return [name && name !== 'Error' ? `${name}: ${text}` : text, status && `(HTTP ${status})`]
    .filter(Boolean)
    .join(' ')
}

// The writes that can't be repeated safely: each stores a new copy, so a
// retry after one that went through makes a duplicate. When one gets no
// answer or a server fault, it may have gone through anyway, so the person
// is told to check rather than to try again.
const UNCONFIRMED: Partial<Record<WalletAction, string>> = {
  delete: "We can't tell whether this credential was deleted.",
  restore: "We can't tell whether this credential was restored.",
  move: "We can't tell whether this credential was moved.",
  upload: "We can't tell whether this credential was added.",
  'create-collection': "We can't tell whether the collection was created.",
  'create-space': "We can't tell whether the space was created.",
}

// Of those, the ones made of several writes (copy, then delete the original;
// create, then name), which can fail after an earlier step went through. Any
// failure of theirs, refusals included, leaves the outcome unknown.
const SEVERAL_STEPS = new Set<WalletAction>(['delete', 'restore', 'move', 'create-collection', 'create-space'])

// A collection name the storage refuses whatever happens: a reserved path
// segment (refused by the WAS client before sending, or by the server), an
// invalid id, or one already taken.
function isNameRefused(error: unknown): boolean {
  const { name, message, type } = readFailure(error)
  return (name === 'ValidationError' && /reserved path segment/i.test(message ?? ''))
    || /#(reserved-id|invalid-id|id-conflict)$/.test(type ?? '')
}

// The storage server's answer to a new Space when the account's coupon (its
// registration token) has no uses left or has expired.
const COUPON_REQUIRED = 'https://github.com/digitalcredentials/was-server-aws#coupon-required'

// Turns a failure into a sentence saying what failed and what the person can
// do. Like batch-issuer-ui's describeFailure, it names a cause only where the
// error shows it, and otherwise says to try again.
export function describeError(action: WalletAction, error: unknown): Failure {
  const detail = technicalDetail(error)
  // The summary, not the error: an HTTP client's error keeps the request it
  // sent, body included (a new Space's coupon, an uploaded credential), and
  // the console outlives a sign-out in the same tab
  console.error(`Wallet: ${action} failed: ${detail}`)
  const { status, name, type } = readFailure(error)
  if (isSessionEnded(error)) {
    return { text: "You've been signed out. Sign in again to keep going.", detail }
  }
  // Only a new collection's own name can clash; elsewhere (Trash, say) the
  // same error is no fault of the person's.
  if (name === 'CollectionExistsError' && action === 'create-collection') {
    return { text: 'You already have a collection with this name. Choose a different name.', detail }
  }
  if (action === 'create-space' && status === 403 && type === COUPON_REQUIRED) {
    return { text: `${FAILED[action]} Your account can't create more spaces right now.`, detail }
  }
  if (action === 'create-collection' && isNameRefused(error)) {
    return { text: "That name can't be used for a collection. Choose a different name.", detail }
  }
  // The WAS client answers a missing credential, and one this session may
  // not see, with null (the server answers both as 404); "may" covers both
  if (name === 'CredentialMissingError') {
    return { text: "We couldn't find this credential. It may have been moved or deleted.", detail }
  }
  const unconfirmed = UNCONFIRMED[action]
  if (unconfirmed && (SEVERAL_STEPS.has(action) || isUnreachable(error) || isServerFault(error))) {
    return { text: `${unconfirmed} Check before trying again.`, detail }
  }
  if (isUnreachable(error)) {
    return { text: `${FAILED[action]} Your storage didn't respond. Check your connection, or try again in a few minutes.`, detail }
  }
  if (isServerFault(error)) {
    return { text: `${FAILED[action]} Your storage had a problem. Try again in a few minutes.`, detail }
  }
  return { text: `${FAILED[action]} Please try again.`, detail }
}
