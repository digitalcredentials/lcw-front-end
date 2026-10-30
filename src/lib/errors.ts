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
  | 'claim'
  | 'save-claim'
  | 'claim-collection'
  | 'load-for-share'
  | 'share'
  | 'connect-mediator'
  | 'welcome-email'
  | 'enable-wallet'
  | 'update-wallet'
  | 'read-file'
  | 'read-qr'
  | 'start-camera'

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
  claim: "We couldn't collect your credential.",
  'save-claim': "We couldn't save your credential.",
  'claim-collection': "We couldn't set up the collection, so your credential isn't saved yet.",
  'load-for-share': "We couldn't load your credentials.",
  share: "We couldn't share your credentials.",
  'connect-mediator': "We couldn't connect to your browser wallet.",
  'welcome-email': "We couldn't send your welcome credential email.",
  'enable-wallet': "We couldn't turn on the browser wallet.",
  'update-wallet': "We couldn't change the browser wallet setting.",
  'read-file': "We couldn't read a credential from that file.",
  'read-qr': "We couldn't read a credential from that QR code.",
  'start-camera': "We couldn't start the camera.",
}

// Who the person was waiting on, named when it didn't respond or had a
// problem; null leaves it unnamed (reading a QR code may fetch a link or a
// context document). An action not listed talks to the learner's own
// storage, and an IssuerError names the issuer whatever the action (a claim
// also writes to storage).
const SERVICE: Partial<Record<WalletAction, string | null>> = {
  'connect-mediator': 'The browser wallet service',
  'enable-wallet': 'The browser wallet service',
  'update-wallet': 'The browser wallet service',
  'read-file': null,
  'read-qr': null,
}

// What a signed-out learner is told. A claim cannot pick up where it stopped
// (the issuer's exchange is usually single-use), so it is started again.
const CLAIM_AGAIN = "You've been signed out. Sign in to your wallet, then go back to the issuer's page and claim the credential again."
const SIGNED_OUT: Partial<Record<WalletAction, string>> = {
  claim: CLAIM_AGAIN,
  'save-claim': CLAIM_AGAIN,
}

// What to do when nothing more specific applies. A claim is started from the
// issuer's page, so that is where it is retried.
const AGAIN: Partial<Record<WalletAction, string>> = {
  claim: "Go back to the issuer's page and try again.",
  'read-file': "Check that it's a credential file or a picture of a credential's QR code.",
  'read-qr': 'Try scanning it again, or ask whoever gave it to you for a new one.',
}

// A failure as the wallet shows it: the sentence, and the technical text
// behind it for whoever is debugging.
export interface Failure {
  text: string
  detail?: string
}

// Thrown with a message already written for the learner, which is shown as
// it is; `detail` keeps whatever technical text explains it.
export class PlainError extends Error {
  detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'PlainError'
    this.detail = detail
  }
}

// Text from outside the wallet (an issuer's error message), made fit for the
// technical details: a string, without control characters or direction
// overrides, and short.
export function outsideText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  // eslint-disable-next-line no-control-regex -- removing them is the point
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim()
  return text ? text.slice(0, 300) : undefined
}

// Thrown for a failed request to an issuer: its HTTP status, or the network
// failure as its cause. Tells a claim's issuer trouble apart from its storage
// writes, and keeps an issuer's answer from reading as the wallet's own.
export class IssuerError extends Error {
  status?: number
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = 'IssuerError'
    this.status = status
  }
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

// The status, name, message and problem type as read off an unknown error,
// and its cause's message: the signed-request HTTP client carries the
// server's problem body on `data`, and an IssuerError keeps the fetch failure
// as its cause. Any of it may be missing, so read it all defensively.
function readFailure(error: unknown): { status?: number; name?: string; message?: string; type?: string; causeMessage?: string } {
  if (typeof error !== 'object' || error === null) {
    return {}
  }
  const { status, name, message, type, data, cause } = error as {
    status?: unknown
    name?: unknown
    message?: unknown
    type?: unknown
    data?: unknown
    cause?: unknown
  }
  const body = typeof data === 'object' && data !== null ? (data as { type?: unknown }) : undefined
  const problemType = typeof type === 'string' ? type : typeof body?.type === 'string' ? body.type : undefined
  const causeMessage = typeof cause === 'object' && cause !== null ? (cause as { message?: unknown }).message : undefined
  return {
    status: typeof status === 'number' ? status : undefined,
    name: typeof name === 'string' ? name : undefined,
    message: typeof message === 'string' ? message : undefined,
    type: problemType,
    causeMessage: typeof causeMessage === 'string' ? causeMessage : undefined,
  }
}

// No session: the wallet's own code throws Error('UNAUTHORIZED') when it
// finds none. Retrying cannot help; signing in can, so handleError sends the
// person to sign in. A session the storage server no longer accepts can't be
// told apart here: the server answers it as not found (404) or, for a
// listing, as an empty list. An issuer's answer is never the wallet's
// session, whatever it says.
export function isSessionEnded(error: unknown): boolean {
  const { name, message } = readFailure(error)
  return message === 'UNAUTHORIZED' && name !== 'IssuerError'
}

function serviceFor(action: WalletAction, error: unknown): string | null {
  const { name } = readFailure(error)
  if (name === 'IssuerError') {
    return 'The issuer'
  }
  // A claim's storage writes fail as WasErrors; a bare fetch TypeError there
  // came from something else it looked up (a context, a DID), so stays unnamed
  if (action === 'claim' && name === 'TypeError') {
    return null
  }
  return action in SERVICE ? (SERVICE[action] as string | null) : 'Your storage'
}

// The person, or the browser wallet service on their behalf, didn't allow
// what the wallet asked for: web-credential-handler throws "Permission
// denied." for any answer but granted, and the camera's is NotAllowedError.
function isRefused(error: unknown): boolean {
  const { name, message } = readFailure(error)
  return name === 'NotAllowedError' || /permission denied/i.test(message ?? '')
}

// No usable camera: qr-scanner turns every getUserMedia failure (blocked,
// absent, busy) into the bare string "Camera not found.", so the cases cannot
// be told apart; the browser's own names are matched too in case it stops.
function isCameraUnavailable(error: unknown): boolean {
  const { name } = readFailure(error)
  return String(error).includes('Camera not found')
    || isRefused(error)
    || ['SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(name ?? '')
}

// No answer from the server at all: the browser's fetch failure ("Failed to
// fetch", Safari's "Load failed", Firefox's "NetworkError…"), which the WAS
// client wraps in a status-less WasError keeping its message and an
// IssuerError keeps as its cause, or the HTTP client's timeout. Matched by
// message, not by the TypeError class, which
// the wallet's own bugs throw too. The browser reports a server error sent
// without CORS headers the same way, so the sentence doesn't blame the
// connection alone.
function isUnreachable(error: unknown): boolean {
  const { status, message, causeMessage } = readFailure(error)
  const network = /Failed to fetch|Load failed|NetworkError|timed out/i
  return status === undefined && (network.test(message ?? '') || network.test(causeMessage ?? ''))
}

// A server fault (5xx): the storage server answered, but with an error.
function isServerFault(error: unknown): boolean {
  const { status, name } = readFailure(error)
  return (status !== undefined && status >= 500) || name === 'WasServerError'
}

// The technical text behind a failure, for the details toggle and the
// console: never the error object, which can carry the request it sent.
export function technicalDetail(error: unknown): string {
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
  // A claimed credential is saved from the pop-up, which has no list to
  // check, so the person is told what saving again would do
  'save-claim': "We can't tell whether your credential was saved. If it was, saving again adds a second copy, which you can delete from your wallet.",
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
  const service = serviceFor(action, error)
  if (error instanceof PlainError) {
    return { text: error.message, detail: error.detail }
  }
  if (isSessionEnded(error)) {
    return { text: SIGNED_OUT[action] ?? "You've been signed out. Sign in again to keep going.", detail }
  }
  if ((action === 'enable-wallet' || action === 'update-wallet') && isRefused(error)) {
    return { text: `${FAILED[action]} It wasn't allowed. Try again, and choose Allow if you're asked.`, detail }
  }
  if (action === 'start-camera' && isCameraUnavailable(error)) {
    return { text: "We couldn't use a camera. Check that this site is allowed to use it and that no other app is using it, or upload a photo of the QR code instead.", detail }
  }
  // qr-scanner rejects with this bare string when an image holds no QR code
  if (action === 'read-file' && String(error).includes('No QR code found')) {
    return { text: "We couldn't find a QR code in that image. Try a clearer picture, or paste the credential's text instead.", detail }
  }
  // Only a new collection's own name can clash; elsewhere (Trash, say) the
  // same error is no fault of the person's.
  if (name === 'CollectionExistsError' && (action === 'create-collection' || action === 'claim-collection')) {
    return { text: 'You already have a collection with this name. Choose a different name.', detail }
  }
  if (action === 'create-space' && status === 403 && type === COUPON_REQUIRED) {
    return { text: `${FAILED[action]} Your account can't create more spaces right now.`, detail }
  }
  if ((action === 'create-collection' || action === 'claim-collection') && isNameRefused(error)) {
    return { text: "That name can't be used for a collection. Choose a different name.", detail }
  }
  // The WAS client answers a missing credential, and one this session may
  // not see, with null (the server answers both as 404); "may" covers both
  if (name === 'CredentialMissingError') {
    return { text: "We couldn't find this credential. It may have been moved or deleted.", detail }
  }
  const unconfirmed = UNCONFIRMED[action]
  if (unconfirmed && (SEVERAL_STEPS.has(action) || isUnreachable(error) || isServerFault(error))) {
    return { text: action === 'save-claim' ? unconfirmed : `${unconfirmed} Check before trying again.`, detail }
  }
  // A claim is started from the issuer's page, so that is where it is retried
  const retry = action === 'claim' ? "go back to the issuer's page and try again" : 'try again'
  if (isUnreachable(error)) {
    return { text: `${FAILED[action]} ${service ? `${service} didn't respond. ` : ''}Check your connection, or ${retry} in a few minutes.`, detail }
  }
  if (isServerFault(error)) {
    return { text: `${FAILED[action]} ${service ? `${service} had a problem. ` : ''}${retry[0].toUpperCase()}${retry.slice(1)} in a few minutes.`, detail }
  }
  return { text: `${FAILED[action]} ${AGAIN[action] ?? 'Please try again.'}`, detail }
}
