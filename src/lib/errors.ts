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

// Who the person was waiting on, named when it can't be reached or isn't
// responding; null leaves it unnamed (reading a QR code may fetch a link or a
// context document). An action not listed talks to the learner's own storage,
// and a claim names the issuer only for an IssuerError (it also writes to
// storage).
const SERVICE: Partial<Record<WalletAction, string | null>> = {
  'welcome-email': 'The issuer',
  'connect-mediator': 'The browser wallet service',
  'enable-wallet': 'The browser wallet service',
  'update-wallet': 'The browser wallet service',
  'read-file': null,
  'read-qr': null,
}
const STORAGE = 'Your storage'

// What a signed-out learner is told. A claim cannot pick up where it stopped
// (the issuer's exchange is usually single-use), so it is started again.
const CLAIM_AGAIN = "You've been signed out. Sign in to your wallet, then go back to the issuer's page and claim the credential again."
const SIGNED_OUT: Partial<Record<WalletAction, string>> = {
  claim: CLAIM_AGAIN,
  'save-claim': CLAIM_AGAIN,
  share: "You've been signed out. Sign in to your wallet, then share again from the site that asked.",
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

// Thrown for a failed request to an issuer: its HTTP status, or the network
// failure as its cause. Tells a claim's issuer trouble apart from its storage
// writes.
export class IssuerError extends Error {
  status?: number
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = 'IssuerError'
    this.status = status
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

// A stored body that is not JSON, and the WAS client's encryption failures
// (EncryptionError and its subclasses): the body exists but cannot be
// decrypted or fails its integrity check.
const UNREADABLE = new Set([
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
// when the session is missing, and the storage server answers 401 when it
// rejects the session's signed requests. Retrying cannot help; signing in can,
// and nothing should stay on screen meanwhile (a shared computer), so callers
// clear the session and send the person to sign in. An issuer's 401 says
// nothing about the wallet's session, so only a 401 from the learner's own
// storage counts.
export function isSessionEnded(action: WalletAction, error: unknown): boolean {
  const { status, name, message } = readFailure(error)
  if (name === 'IssuerError') {
    return false
  }
  return (status === 401 && serviceFor(action, error) === STORAGE) || message === 'UNAUTHORIZED'
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
  return action in SERVICE ? (SERVICE[action] as string | null) : STORAGE
}

// The browser refused the permission the wallet asked for (registering as a
// credential handler, or the camera): only the person can change that.
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
  const service = serviceFor(action, error)
  if (error instanceof PlainError) {
    return { text: error.message, detail: error.detail }
  }
  if (isSessionEnded(action, error)) {
    return { text: SIGNED_OUT[action] ?? "You've been signed out. Sign in again to keep going.", detail }
  }
  if ((action === 'enable-wallet' || action === 'update-wallet') && isRefused(error)) {
    return { text: `${FAILED[action]} Your browser blocked it. Allow it when your browser asks, or check this site's permissions, then try again.`, detail }
  }
  if (action === 'start-camera' && isCameraUnavailable(error)) {
    return { text: "We couldn't use a camera. Check that this site is allowed to use it and that no other app is using it, or upload a photo of the QR code instead.", detail }
  }
  // qr-scanner rejects with this bare string when an image holds no QR code
  if (action === 'read-file' && String(error).includes('No QR code found')) {
    return { text: "We couldn't find a QR code in that image. Try a clearer picture, or paste the credential's text instead.", detail }
  }
  if (isUnreachable(error)) {
    return { text: `${FAILED[action]} ${service ? `${service} can't be reached right now. ` : ''}Check your connection and try again.`, detail }
  }
  // Only a collection the person is naming can clash (a new one, or one made
  // while saving a claim); elsewhere (Trash, say) it is no fault of theirs.
  if (name === 'CollectionExistsError' && action === 'create-collection') {
    return { text: 'You already have a collection with this name. Choose a different name.', detail }
  }
  if (name === 'CollectionExistsError' && action === 'save-claim') {
    return { text: "You already have a collection with this name. Go back to the issuer's page, claim the credential again, and choose another collection or name.", detail }
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
    return { text: `${FAILED[action]} ${service ? `${service} isn't responding right now. ` : ''}Try again in a few minutes.`, detail }
  }
  return { text: `${FAILED[action]} ${AGAIN[action] ?? 'Please try again.'}`, detail }
}
