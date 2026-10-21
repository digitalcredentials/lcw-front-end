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

// Thrown when a stored credential's body is missing or cannot be parsed, so it
// reads as "couldn't be read" rather than as a generic failure.
export class UnreadableCredentialError extends Error {
  constructor(message = 'The credential could not be read.') {
    super(message)
    this.name = 'UnreadableCredentialError'
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

// The WAS client's encryption failures (EncryptionError and its subclasses):
// the stored body exists but cannot be decrypted or fails its integrity check.
const UNREADABLE = new Set([
  'UnreadableCredentialError',
  'SyntaxError',
  'EncryptionError',
  'KeyUnwrapError',
  'IntegrityError',
  'EncryptOnlyCipherError',
  'UnverifiedDescriptorError',
])

// The status and name as read off an unknown error, and off its cause: the
// WAS client wraps a network failure in a status-less WasError whose cause is
// the fetch TypeError. Any of it may be missing, so read it all defensively.
function readFailure(error: unknown): { status?: number; name?: string; message?: string; causeName?: string } {
  if (typeof error !== 'object' || error === null) {
    return {}
  }
  const { status, name, message, cause } = error as {
    status?: unknown
    name?: unknown
    message?: unknown
    cause?: unknown
  }
  const causeName = typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined
  return {
    status: typeof status === 'number' ? status : undefined,
    name: typeof name === 'string' ? name : undefined,
    message: typeof message === 'string' ? message : undefined,
    causeName: typeof causeName === 'string' ? causeName : undefined,
  }
}

// A signed-out session: the wallet's own code throws Error('UNAUTHORIZED')
// when the session is missing (handleError sends the person to sign in), and
// the server answers 401. Retrying cannot help; signing in can.
function isSessionEnded(error: unknown): boolean {
  const { status, message } = readFailure(error)
  return status === 401 || message === 'UNAUTHORIZED'
}

// No answer from the server at all: the browser's fetch failure ("Failed to
// fetch", Safari's "Load failed", Firefox's "NetworkError…"), which the WAS
// client wraps as the cause of a status-less WasError, or the HTTP client's
// timeout. A TypeError from the wallet's own code is not one of these.
function isUnreachable(error: unknown): boolean {
  const { status, message, causeName } = readFailure(error)
  return status === undefined
    && (causeName === 'TypeError' || /Failed to fetch|Load failed|NetworkError|timed out/i.test(message ?? ''))
}

// The technical text behind a failure, for the details toggle.
function technicalDetail(error: unknown): string {
  const { status, name, message } = readFailure(error)
  const text = message ?? String(error)
  return [name && name !== 'Error' ? `${name}: ${text}` : text, status && `(HTTP ${status})`]
    .filter(Boolean)
    .join(' ')
}

// The actions on one credential, where "its contents" and "moved or deleted"
// name the thing the person was acting on.
const ON_A_CREDENTIAL = new Set<WalletAction>(['open', 'delete', 'restore', 'move'])

// Turns a failure into a sentence saying what failed and what the person can
// do, and logs the raw error so the detail is not lost.
export function describeError(action: WalletAction, error: unknown): Failure {
  console.error(`Wallet: ${action} failed`, error)
  const detail = technicalDetail(error)
  const { status, name } = readFailure(error)
  if (isSessionEnded(error)) {
    return { text: "You've been signed out. Sign in again to keep going.", detail }
  }
  if (isUnreachable(error)) {
    return { text: `${FAILED[action]} Your storage can't be reached right now. Check your connection and try again.`, detail }
  }
  // Only a new collection's own name can clash; elsewhere (Trash, say) the
  // same error is no fault of the person's.
  if (name === 'CollectionExistsError' && action === 'create-collection') {
    return { text: 'You already have a collection with this name. Choose a different name.', detail }
  }
  if (ON_A_CREDENTIAL.has(action) && name !== undefined && UNREADABLE.has(name)) {
    return { text: `${FAILED[action]} Its contents couldn't be read. Try again, or add the credential again if this keeps happening.`, detail }
  }
  if ((ON_A_CREDENTIAL.has(action) || action === 'load-credentials') && (status === 404 || name === 'NotFoundError')) {
    return { text: `${FAILED[action]} It may have been moved or deleted. Refresh to see what's there now.`, detail }
  }
  // A server fault that may pass; 501 (not supported) and 507 (storage full)
  // will not, so they are not offered a wait.
  if ((status !== undefined && status >= 500 && status !== 501 && status !== 507) || name === 'WasServerError') {
    return { text: `${FAILED[action]} Your storage isn't responding right now. Try again in a few minutes.`, detail }
  }
  return { text: `${FAILED[action]} Please try again.`, detail }
}
