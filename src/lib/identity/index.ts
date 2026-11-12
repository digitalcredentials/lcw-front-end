import { KEYRING_KDF } from '@interop/wallet-core/keyring'
import { formatRecoveryCode, recordedDelegationFields } from '@interop/wallet-core/recovery'
import { ladderRung } from '@interop/wallet-core/webvh'
import { deriveUnlockCredential, passphraseCredential, type UnlockCredential } from './credential'
import { delegateUnlockManagement, fetchStandingRecord, type StandingRecord } from './records'
import { openTransientSession, TransientLoginUnavailableError } from './transient'
import { openRememberedSession } from './remembered'
import { addStandingCredential } from './standing'
import { signUp, AccountExistsError } from './signup'
import { issueRecoveryCode, recoverWithCode } from './recovery'
import { upsertMethod, upsertPassphraseMethod, emptyRegistry, type UnlockMethod } from './unlockMethods'
import type { CollectionEncryption } from '@interop/pws-client'
import type { UserKey } from '@interop/wallet-core/keys'
import { healRegistry, readRegistry, updateRegistry } from './registry'
import { sweepCollectionsToUserKey } from './authority'
import { nameOwnClient } from './clients'
import { PASSKEY_KDF, assertPasskey, registerPasskey } from './passkey'
import { defaultClientKeyStore, deleteAllClientKeyRecords, hasAnyClientKeyRecord, type ClientKeyStore } from './clientKeyRecord'
import { sessionAgents, type RememberedSession, type Session, type TransientSession } from './session'
import { fromBase64url, toBase64url } from './bytes'

// The identity layer's entry points: registration, sign-in with a
// passphrase (a transient session), a passkey (a remembered one) or a
// recovery code, adding a passkey, changing the passphrase, recovery codes
// held by the back end, and the list of sign-in methods. All take their
// configuration as arguments so the same code runs in the wallet (from
// Vite's env) and in the test scripts (from the shell).

export interface IdentityConfig {
  // lcw-back-end, which registers the email, verifies sign-in and holds the
  // recovery code
  apiBase: string
  // The PWS server the account's spaces live on
  serverUrl: string
}

interface ErrorBody {
  message?: string
  error?: string
}

export interface LoginResult {
  verified: boolean
  email: string
  controller: string
  token?: string
}

export const invalidCredentials = () => Object.assign(new Error('Invalid email or password.'), { status: 401 })

// Proves the session to the back end: the acting identity signs the login
// (the enrolled client as the account, or the visit's annex identity),
// and the registration token comes back as the session's coupon.
async function backEndLogin({ session, email, config }: { session: Omit<Session, 'email' | 'coupon'>; email: string; config: Pick<IdentityConfig, 'apiBase'> }): Promise<LoginResult> {
  const { zcapClient } = await sessionAgents({ ...session, email } as Session)
  const response = await zcapClient.request({ url: `${config.apiBase}/login`, method: 'POST', action: 'write', json: { email } })
  return response.data as LoginResult
}

export async function registerAccount({
  email,
  passphrase,
  registrationCode,
  config,
  onStage,
}: {
  email: string
  passphrase: string
  registrationCode: string
  config: IdentityConfig
  onStage?: (stage: string) => void
}): Promise<string> {
  const { message } = await signUp({ email, passphrase, registrationCode, config, onStage })
  return message
}

async function enterTransiently({
  credential,
  found,
  email,
  config,
}: {
  credential: UnlockCredential
  found: StandingRecord
  email: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<TransientSession> {
  const { session, userKeyGenerations, rosterDescriptor } = await openTransientSession({ credential, found, serverUrl: config.serverUrl })
  const login = await backEndLogin({ session, email, config })
  const opened: TransientSession = { ...session, email: login.email ?? email, coupon: login.token }
  await settleAfterRotation({ session: opened, generations: userKeyGenerations, rosterDescriptor })
  return opened
}

// What a sign-in settles after a user-key rotation another session ran:
// the registry, re-sealed when the rotation left it under the earlier key,
// and every encrypted collection, brought onto the current key when the
// rotation's fan-out was interrupted. Best effort: the session opens
// either way, and the pages report what they cannot open.
async function settleAfterRotation({ session, generations, rosterDescriptor }: { session: Session; generations: UserKey[]; rosterDescriptor: CollectionEncryption | null }): Promise<void> {
  try {
    await healRegistry({ session, generations })
  } catch (err) {
    console.warn('The sign-in methods registry could not be opened:', err)
  }
  if (!rosterDescriptor) {
    return
  }
  try {
    const swept = await sweepCollectionsToUserKey({ session, rosterDescriptor, generations })
    if (swept) {
      console.info('Wallet: collections brought onto the current user key at sign-in:', swept.outcomes, swept.failed)
    }
  } catch (err) {
    console.warn('The collections could not be brought onto the current user key:', err)
  }
}

// This browser's client, named in the account's connections directory
// after it enrolled. Best effort: the client is enrolled either way, and
// the wallets list shows it unnamed until it is.
async function settleOwnClientName(session: RememberedSession): Promise<void> {
  try {
    await nameOwnClient(session)
  } catch (err) {
    console.warn("This browser's client could not be named in the connections directory:", err)
  }
}

// Signs in with a passphrase: a transient session for this tab.
export async function loginWithPassphrase({ email, passphrase, config }: { email: string; passphrase: string; config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<Session> {
  const credential = await passphraseCredential(passphrase)
  const found = await fetchStandingRecord({ credential, serverUrl: config.serverUrl })
  if (!found) {
    throw invalidCredentials()
  }
  return enterTransiently({ credential, found, email, config })
}

// Signs in with a passkey: the browser offers the account's discoverable
// passkeys, the chosen one's PRF output derives its credential, and this
// browser's client-key record (or a self-enrollment on a fresh browser)
// opens a remembered session. The email comes from the credential's record.
export async function loginWithPasskey({ config, store = defaultClientKeyStore }: { config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>; store?: ClientKeyStore }): Promise<Session> {
  const { prfOutput } = await assertPasskey()
  return loginWithPasskeySecret({ prfOutput, config, store })
}

export async function loginWithPasskeySecret({
  prfOutput,
  config,
  store = defaultClientKeyStore,
  email: typedEmail,
}: {
  prfOutput: Uint8Array
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
  store?: ClientKeyStore
  email?: string
}): Promise<Session> {
  const credential = await deriveUnlockCredential({ secret: prfOutput, kdf: PASSKEY_KDF })
  const found = await fetchStandingRecord({ credential, serverUrl: config.serverUrl })
  if (!found) {
    throw Object.assign(new Error('This passkey is not registered with an account.'), { status: 401 })
  }
  const email = typedEmail ?? found.email
  if (!email) {
    throw new Error('The passkey carries no account email.')
  }
  const { session, enrolled, userKeyGenerations, rosterDescriptor } = await openRememberedSession({ credential, found, serverUrl: config.serverUrl, store })
  const login = await backEndLogin({ session, email, config })
  const opened: RememberedSession = { ...session, email: login.email ?? email, coupon: login.token }
  await settleAfterRotation({ session: opened, generations: userKeyGenerations, rosterDescriptor })
  if (enrolled) {
    await settleOwnClientName(opened)
  }
  return opened
}

// Signs in with a recovery code: a transient session on the code's
// credential.
export async function loginWithRecoveryCode({ email, code, config }: { email: string; code: string; config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<Session> {
  const recovered = await recoverWithCode({ code, serverUrl: config.serverUrl })
  if (!recovered) {
    throw Object.assign(new Error('That recovery code is not valid.'), { status: 401 })
  }
  const login = await backEndLogin({ session: recovered.session, email, config })
  return { ...recovered.session, email: login.email ?? email, coupon: login.token }
}

export { readRegistry, updateRegistry }

export type SignInMethodKind = 'passphrase' | 'passkey' | 'recovery-code' | 'backup-credential'

export interface SignInMethod {
  kind: SignInMethodKind
  label: string
  createdAt: string
  unlockSpaceId: string
  // The method that opened this session
  current: boolean
}

function methodLabel(method: UnlockMethod): string {
  switch (method.type) {
    case 'passphrase':
      return 'Password'
    case 'passkey':
      return method.label || 'Passkey'
    case 'recovery-code':
      return method.label || 'Recovery code'
    case 'backup-credential':
      return method.label || 'Backup file'
  }
}

export async function listSignInMethods({ session }: { session: Session }): Promise<SignInMethod[]> {
  const registry = await readRegistry(session)
  return (registry?.methods ?? []).map((method) => ({
    kind: method.type,
    label: methodLabel(method),
    createdAt: method.createdAt,
    unlockSpaceId: method.unlockSpaceId,
    current: method.unlockSpaceId === session.unlockSpaceId,
  }))
}

export function requireTransient(session: Session): TransientSession {
  if (session.kind !== 'transient') {
    throw new Error('This step runs from a session opened with a password or a recovery code.')
  }
  return session
}

// Adds a passkey to the account from a transient session and remembers
// this browser under it: the passkey becomes a standing credential, this
// browser enrolls as a client whose key record the passkey's PRF output
// opens, and the session continues as that client.
export async function addPasskey({ session, config, rpName, store = defaultClientKeyStore }: { session: Session; config: Pick<IdentityConfig, 'serverUrl'>; rpName: string; store?: ClientKeyStore }): Promise<Session> {
  const transient = requireTransient(session)
  const registry = (await readRegistry(session)) ?? emptyRegistry()
  const registration = await registerPasskey({ userHandle: fromBase64url(registry.webAuthnUserId), email: session.email, rpName })
  return addPasskeyCredential({
    session: transient,
    prfOutput: registration.prfOutput,
    config,
    store,
    entry: { credentialId: toBase64url(registration.credentialId), transports: registration.transports, backupEligibility: registration.backupEligibility, backupState: registration.backupState },
  })
}

// The passkey's credential half, separable for tests without WebAuthn.
export async function addPasskeyCredential({
  session,
  prfOutput,
  config,
  store = defaultClientKeyStore,
  entry,
  label = `Passkey added ${new Date().toLocaleDateString()}`,
}: {
  session: TransientSession
  prfOutput: Uint8Array
  config: Pick<IdentityConfig, 'serverUrl'>
  store?: ClientKeyStore
  entry?: { credentialId: string; transports: string[]; backupEligibility: boolean; backupState: boolean }
  label?: string
}): Promise<Session> {
  const credential = await deriveUnlockCredential({ secret: prfOutput, kdf: PASSKEY_KDF })
  const established = await addStandingCredential({ session, credential, lowEntropy: false, email: session.email })
  await updateRegistry(session, (existing) =>
    upsertMethod({
      record: existing ?? emptyRegistry(),
      entry: {
        type: 'passkey',
        label,
        createdAt: new Date().toISOString(),
        credentialId: entry?.credentialId ?? '',
        transports: entry?.transports ?? [],
        backupEligibility: entry?.backupEligibility ?? false,
        backupState: entry?.backupState ?? false,
        unlockSpaceId: established.unlockSpaceId,
        ...(established.manageCapability && { manageCapability: established.manageCapability }),
        ...established.standingFields,
      },
    })
  )
  // This browser, enrolled under the new credential
  const found = await fetchStandingRecord({ credential, serverUrl: config.serverUrl })
  if (!found) {
    throw new Error('The passkey credential was not found after it was added.')
  }
  const remembered = await openRememberedSession({ credential, found, serverUrl: config.serverUrl, store })
  const opened: RememberedSession = { ...remembered.session, email: session.email, coupon: session.coupon }
  if (remembered.enrolled) {
    await settleOwnClientName(opened)
  }
  return opened
}

// Sets a new passphrase from a transient session: a new standing
// credential replaces the registry's passphrase entry. The previous
// passphrase keeps opening the account until its credential is removed.
export async function changePassphrase({ session, passphrase }: { session: Session; passphrase: string }): Promise<void> {
  const transient = requireTransient(session)
  const credential = await passphraseCredential(passphrase)
  const found = await fetchStandingRecord({ credential, serverUrl: session.serverUrl })
  if (found) {
    // A passphrase this account already has (set earlier, and kept as a
    // credential until removing methods exists) is listed again from its
    // record; one that belongs to another account is refused
    if (found.pointer.did !== session.did || !found.ladderSeed) {
      throw new AccountExistsError()
    }
    const { standing, unlock } = credential
    const rung0 = await ladderRung({ ladderSeed: found.ladderSeed, index: 0 })
    const manageCapability = await delegateUnlockManagement({ credential, serverUrl: session.serverUrl, to: session.did })
    await updateRegistry(session, (existing) =>
      upsertPassphraseMethod({
        record: existing ?? emptyRegistry(),
        unlockSpaceId: unlock.spaceId,
        manageCapability,
        standing: {
          rosterKid: standing.recipientKid,
          keyAgreementKeyMultibase: standing.keyAgreementKeyMultibase,
          updateKeyMultibase: rung0.keyMultibase,
          ...recordedDelegationFields({ delegation: found.delegation, ...(found.delegatedClients && { delegatedClients: found.delegatedClients }) }),
          unlockClientDid: standing.clientDid,
          unlockKeyAgreementKeyId: unlock.keyAgreementKey.id,
          unlockKeyAgreementKeyMultibase: unlock.keyAgreementKey.publicKeyMultibase,
        },
      })
    )
    return
  }
  const established = await addStandingCredential({ session: transient, credential, lowEntropy: true, email: session.email })
  await updateRegistry(session, (existing) =>
    upsertPassphraseMethod({ record: existing ?? emptyRegistry(), unlockSpaceId: established.unlockSpaceId, manageCapability: established.manageCapability, standing: established.standingFields })
  )
}

// Whether the back end holds a recovery code for the account: a read it
// answers only to the account (or its client annex), so the session signs
// it. An unreadable answer counts as none held.
export async function hasStoredRecoveryCode({ session, config }: { session: Session; config: Pick<IdentityConfig, 'apiBase'> }): Promise<boolean> {
  try {
    const { zcapClient } = await sessionAgents(session)
    const response = await zcapClient.request({ url: `${config.apiBase}/recovery?email=${encodeURIComponent(session.email)}`, method: 'GET', action: 'read' })
    return (response.data as { stored?: boolean } | undefined)?.stored === true
  } catch {
    return false
  }
}

// Issues a recovery code and hands it to the back end, which emails it to
// the account's address on request (the wallet never shows it). An account
// the back end already holds a code for gets none, unless forced.
export async function ensureRecoveryCode({ session, config, force = false }: { session: Session; config: Pick<IdentityConfig, 'apiBase'>; force?: boolean }): Promise<{ issued: boolean; code?: string }> {
  if (!force && (await hasStoredRecoveryCode({ session, config }))) {
    return { issued: false }
  }
  const { code, entry } = await issueRecoveryCode({ session })
  await updateRegistry(session, (existing) => upsertMethod({ record: existing ?? emptyRegistry(), entry }))
  const formatted = formatRecoveryCode({ code })
  const { zcapClient } = await sessionAgents(session)
  await zcapClient.request({ url: `${config.apiBase}/recovery`, method: 'PUT', action: 'write', json: { email: session.email, code: formatted } })
  // The code is handed back for the scripts; the wallet's pages never show it
  return { issued: true, code: formatted }
}

// Asks the back end to email the account's recovery code. Always answers
// as if it had, so an address cannot be probed.
export async function requestRecoveryEmail({ email, config }: { email: string; config: Pick<IdentityConfig, 'apiBase'> }): Promise<void> {
  const res = await fetch(`${config.apiBase}/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
  if (!res.ok && res.status !== 202) {
    const body = (await res.json().catch(() => ({}))) as ErrorBody
    throw new Error(body.error ?? 'The recovery email could not be sent.')
  }
}

// Recovers the account with the emailed code: signs in on the code, sets
// the new passphrase, and replaces the code with a fresh one.
export async function recoverAccount({ email, code, passphrase, config }: { email: string; code: string; passphrase: string; config: IdentityConfig }): Promise<Session> {
  const session = await loginWithRecoveryCode({ email, code, config })
  await changePassphrase({ session, passphrase })
  await ensureRecoveryCode({ session, config, force: true })
  return session
}

// Whether this browser holds a remembered client (a passkey can open the
// account without the form).
export const browserRemembered = (): Promise<boolean> => hasAnyClientKeyRecord()

// Forgets every remembered client this browser holds. The clients stay
// listed in the account document until they are disconnected.
export async function forgetThisBrowser(): Promise<void> {
  await deleteAllClientKeyRecords()
}

export { KEYRING_KDF, PASSKEY_KDF }
export { getSession, setSession, clearSession, sessionAgents, sessionEncryption, sessionKeyAgreementKey, sessionSpaceUrl, sessionVaultKeys, sessionReachesOtherSpaces } from './session'
export type { Session, TransientSession, RememberedSession } from './session'
export { passkeySupported, PasskeyCancelledError, PasskeyUnsupportedError } from './passkey'
export { acceptedMethodsOf, chooseAccountMethod, accountDid, accountMethodOf, holderSigner, webDidOf } from './holder'
export type { AccountDidMethod, HolderSigner } from './holder'
export { AccountExistsError, TransientLoginUnavailableError }
export { memoryClientKeyStore } from './clientKeyRecord'
export type { ClientKeyStore } from './clientKeyRecord'
export { CLIENT_NAME, approveConnectCode, disconnectWallet, inspectConnectCode, isConnectCode, listConnectedWallets, refusalMessage, renameConnectedWallet } from './clients'
export type { ConnectedWallet, DisconnectOutcome } from './clients'
