import { WasClient } from '@interop/was-client'
import { collectionDescriptorStore, ownerRecipient, replaceRecipient } from '@interop/was-client/edv'
import { deriveUnlockIdentity, deleteUnlockSpace, recordSignerFromAgent } from '@interop/wallet-core/keyring'
import { userKeyVaultKeys } from '@interop/wallet-core/keys'
import { webvhZcapClient } from '@interop/wallet-core/webvh'
import { createAccountLog, ensureProjection, publishAccountLog, promoteSpace } from './account'
import { addCredentialToLog, credentialsInLog, publicKeysOf, readAccountLog, removeCredentialFromLog, type RemovableCredential } from './credentials'
import { readCatalogue, updateCatalogue, type CatalogueEntry, type CredentialKind } from './catalogue'
import { RECOVERY_KDF, mintRecoveryCode, recoverySecretOf } from './recoveryCode'
import { mintCredentialKeys, mintUserKey, multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed, type CredentialKeys, type UserKey } from './keys'
import { PASSKEY_KDF, assertPasskey, registerPasskey } from './passkey'
import { bindCredential, openPassphrase, readCredential, retireCredentialRecords, rewrapUserKey, type IZcap, type UnlockIdentity, type UnlockedKeys } from './unlock'
import { sessionAgents, type Session } from './session'

// The identity layer's entry points: registration, sign-in with either kind
// of credential, adding and removing credentials (a removal rotates the
// account's user key), and recovery. All take their configuration as
// arguments so the same code runs in the wallet (from Vite's env) and in the
// test scripts (from the shell).

export interface IdentityConfig {
  // lcw-back-end, which registers the email and verifies sign-in
  apiBase: string
  // The PWS server the account's spaces live on
  serverUrl: string
  // The identity domain the account's did:webvh names
  idDomain: string
}

export const MAIN_SPACE_NAME = 'Main Space'
const spacesUrl = (serverUrl: string) => `${serverUrl}/spaces/`

interface ErrorBody {
  message?: string
  error?: string
}

async function accountClient(session: Session): Promise<WasClient> {
  const { asAccount } = await sessionAgents(session)
  return WasClient.fromSigner({ serverUrl: spacesUrl(session.serverUrl), signer: asAccount.signer })
}

// Records a credential in the account's catalogue (catalogue.ts).
export async function catalogueCredential({
  session,
  keys,
  kind,
  label,
  unlock,
  capability,
}: {
  session: Session
  keys: CredentialKeys
  kind: CredentialKind
  label?: string
  unlock: UnlockIdentity
  capability: IZcap
}): Promise<void> {
  const pub = await publicKeysOf(keys)
  const entry: CatalogueEntry = {
    kind,
    ...(label && { label }),
    createdAt: new Date().toISOString(),
    updateMultibase: pub.updateMultibase,
    stagedMultibase: pub.stagedMultibase,
    unlockDid: unlock.agent.id,
    unlockSpaceId: unlock.spaceId,
    capability,
  }
  await updateCatalogue(session, (catalogue) => {
    catalogue.credentials[pub.signingMultibase] = entry
  })
}

// Registers an account. In order: the Main Space is created with the
// registration code as coupon (a wrong code stops here); the account's DID
// log is minted and published into the space; the back end records the
// email against the account's did:webvh and emails the confirmation link;
// the space is promoted to the DID; the passphrase is bound as the first
// credential and catalogued. Every key is minted here at random.
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
  const credential = mintCredentialKeys()
  const userKey = await mintUserKey()
  const agents = await signingAgents(credential.signingSeed)
  const controller = agents.controllerDid

  onStage?.('Creating your storage space')
  const created = await agents.zcapClient.request({
    url: spacesUrl(config.serverUrl),
    method: 'POST',
    action: 'POST',
    json: { controller, name: MAIN_SPACE_NAME, type: ['Space'], coupon: registrationCode },
  })
  const spaceId = (created.data as { id: string }).id
  const was = await WasClient.fromSigner({ serverUrl: spacesUrl(config.serverUrl), signer: agents.keyAgent.getSigner() })

  onStage?.('Publishing your identity')
  const updateKey = await updateKeyFromSeed(credential.updateSeed)
  const { did, jsonl } = await createAccountLog({
    idDomain: config.idDomain,
    spaceId,
    signingMultibase: multibaseOf(controller),
    userKeyMultibase: multibaseOf(userKey.id),
    updateKey,
    stagedMultibase: await multibaseOfSeed(credential.stagedSeed),
  })
  await publishAccountLog({ was, spaceId, jsonl })

  onStage?.('Registering the account')
  const res = await fetch(`${config.apiBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, did, registrationCode }),
  })
  const body = (await res.json().catch(() => ({}))) as ErrorBody
  if (!res.ok) {
    // The space is the only thing created so far; it still answers to the key
    await was.space(spaceId).deleteWithOutcome().catch(() => undefined)
    throw new Error(body.error ?? 'Unable to register. Please try again.')
  }
  await promoteSpace({ was, spaceId, did, name: MAIN_SPACE_NAME })

  onStage?.('Securing your passphrase')
  const unlock = await openPassphrase(passphrase)
  const { capability } = await bindCredential({
    unlock,
    serverUrl: config.serverUrl,
    controller,
    email,
    pointer: { did, spaceId, host: config.serverUrl },
    keys: { credential, userKey },
  })
  const session: Session = { email, did, controller, serverUrl: config.serverUrl, spaceId, signingSeed: credential.signingSeed, userKey }
  await catalogueCredential({ session, keys: credential, kind: 'passphrase', unlock, capability })

  return body.message ?? 'Registration started. Check your email for a confirmation link.'
}

export interface LoginResult {
  verified: boolean
  email: string
  controller: string
  token?: string
}

// Opens the account an unlock identity is bound to and proves it to the
// back end: the credential's signing key signs the login under the
// account's did:webvh, which the back end verifies against the account
// document. Resolves to the session and the credential's full keys (the
// update keys among them, for a caller about to add a credential).
async function openCredential({
  unlock,
  email,
  config,
}: {
  unlock: UnlockIdentity
  // The typed email, or undefined to take the credential's record
  email?: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<{ session: Session; keys: UnlockedKeys }> {
  const found = await readCredential({ unlock, serverUrl: config.serverUrl })
  if (!found) {
    throw Object.assign(new Error('Invalid email or password.'), { status: 401 })
  }
  const { contents, keys } = found
  const pointer = contents.pointer
  if (!pointer?.did) {
    throw new Error('This credential is not bound to a promoted account.')
  }
  const agents = await signingAgents(keys.credential.signingSeed)
  if (agents.controllerDid !== contents.controller) {
    throw new Error('The stored keys do not match the credential.')
  }
  const accountEmail = email ?? contents.email
  if (!accountEmail) {
    throw new Error('The credential carries no account email.')
  }
  const zcapClient = webvhZcapClient({ keyAgent: agents.keyAgent, did: pointer.did })
  const response = await zcapClient.request({
    url: `${config.apiBase}/login`,
    method: 'POST',
    action: 'write',
    json: { email: accountEmail },
  })
  const result = response.data as LoginResult
  const session: Session = {
    email: result.email ?? accountEmail,
    coupon: result.token,
    did: pointer.did,
    controller: contents.controller,
    serverUrl: pointer.host,
    spaceId: pointer.spaceId,
    signingSeed: keys.credential.signingSeed,
    userKey: keys.userKey,
  }
  // A projection a failed write left stale is put right; best effort, the
  // sign-in stands either way.
  try {
    await ensureProjection({ was: await accountClient(session), spaceId: session.spaceId })
  } catch (err) {
    console.warn('The did:web projection could not be checked:', err)
  }
  return { session, keys }
}

// Signs in with a passphrase, returning the session and the credential's
// keys (for the add-a-passkey step that may follow).
export async function openWithPassphrase({
  email,
  passphrase,
  config,
}: {
  email: string
  passphrase: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<{ session: Session; keys: UnlockedKeys }> {
  return openCredential({ unlock: await openPassphrase(passphrase), email, config })
}

export async function loginWithPassphrase(options: {
  email: string
  passphrase: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<Session> {
  return (await openWithPassphrase(options)).session
}

// Signs in with a passkey: the browser offers the account's discoverable
// passkeys, the chosen one's PRF output derives its unlock identity, and
// the account email comes from the credential's record.
export async function openWithPasskey({ config }: { config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<{ session: Session; keys: UnlockedKeys }> {
  const { prfOutput } = await assertPasskey()
  const unlock = await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF })
  return openCredential({ unlock, config })
}

export async function loginWithPasskey(options: { config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<Session> {
  return (await openWithPasskey(options)).session
}

// Adds a credential to the signed-in account: mints its signing and update
// keys, publishes them to the account document (signed by the acting
// credential's update key, unwrapped for this operation alone), binds its
// unlock space with the pointer record and the sealed records, and
// catalogues it with the management capability the binding delegated.
// Resolves to the new credential's keys.
export async function addCredential({
  session,
  acting,
  config,
  unlock,
  kind,
  label,
}: {
  session: Session
  acting: CredentialKeys
  config: Pick<IdentityConfig, 'serverUrl'>
  unlock: UnlockIdentity
  kind: CredentialKind
  label?: string
}): Promise<CredentialKeys> {
  const keys = mintCredentialKeys()
  await addCredentialToLog({ was: await accountClient(session), spaceId: session.spaceId, did: session.did, acting, added: await publicKeysOf(keys) })
  const agents = await signingAgents(keys.signingSeed)
  const { capability } = await bindCredential({
    unlock,
    serverUrl: config.serverUrl,
    controller: agents.controllerDid,
    email: session.email,
    pointer: { did: session.did, spaceId: session.spaceId, host: session.serverUrl },
    keys: { credential: keys, userKey: session.userKey },
  })
  await catalogueCredential({ session, keys, kind, label, unlock, capability })
  return keys
}

// Adds a passkey to the signed-in account as a credential of its own:
// registers it with the browser, then adds it like any credential.
export async function addPasskey({
  session,
  acting,
  config,
  rpName,
}: {
  session: Session
  acting: CredentialKeys
  config: Pick<IdentityConfig, 'serverUrl'>
  rpName: string
}): Promise<void> {
  const { prfOutput } = await registerPasskey({ email: session.email, rpName })
  const unlock = await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF })
  await addCredential({ session, acting, config, unlock, kind: 'passkey' })
}

// ---- credential management ---------------------------------------------------

// A credential of the account as the settings page lists it: the document's
// view joined with the catalogue's.
export interface AccountCredential {
  signingMultibase: string
  updateMultibase: string | null
  stagedHash: string | null
  kind: CredentialKind | 'unknown'
  label?: string
  addedAt: string
  // Opened this session
  current: boolean
  // Whether removeCredential will take it: not this session's, not the
  // recovery code (replaced automatically; see mintRecoveryCredential), and
  // paired with an update key in the log
  removable: boolean
}

export async function listCredentials({ session }: { session: Session }): Promise<AccountCredential[]> {
  const [{ log }, catalogue] = await Promise.all([readAccountLog({ was: await accountClient(session), spaceId: session.spaceId }), readCatalogue(session)])
  const mine = multibaseOf(session.controller)
  const listed = await credentialsInLog(log)
  return listed
    .map((entry) => {
      const known = catalogue.credentials[entry.signingMultibase]
      const current = entry.signingMultibase === mine
      const kind = known?.kind ?? 'unknown'
      return {
        ...entry,
        kind,
        ...(known?.label && { label: known.label }),
        addedAt: known?.createdAt ?? entry.addedAt,
        current,
        removable: !current && entry.updateMultibase !== null && kind !== 'recovery',
      }
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
}

// The ids of every Space of the account: the server lists by signing DID,
// and every Space is promoted to the account's did:webvh, but one whose
// promotion tore stays under the signing key's did:key, so both listings are
// read and merged, following each listing's `next` links.
async function accountSpaceIds(session: Session): Promise<string[]> {
  const { asAccount, asKey } = await sessionAgents(session)
  const ids = new Set<string>()
  for (const zcapClient of [asAccount.zcapClient, asKey.zcapClient]) {
    let url: string | undefined = spacesUrl(session.serverUrl)
    while (url) {
      const response = await zcapClient.request({ url, method: 'GET', action: 'GET' })
      const page = response.data as { items?: { id?: string; url?: string }[]; next?: string }
      for (const item of page.items ?? []) {
        const id = item.id ?? item.url?.replace(/\/+$/, '').split('/').pop()
        if (id) {
          ids.add(id)
        }
      }
      url = page.next
    }
  }
  return [...ids]
}

// Rotates every encrypted collection of the account from one user key to
// another: a fresh epoch for new writes wrapped to the new key and every
// earlier epoch re-wrapped to it (was-client's replaceRecipient: one read
// and one compare-and-swap write per collection), then the old key's wraps
// dropped from every epoch in a second write, so the old key unwraps
// nothing the server serves from now on. Records are not re-encrypted: a
// copy of ciphertext taken before the rotation stays readable to a copy of
// the old key. When a collection fails, the ones already rotated are rotated
// back and the error propagates, so the account is never left half on each
// key.
async function rotateCollections({ session, from, to }: { session: Session; from: UserKey; to: UserKey }): Promise<number> {
  const was = await accountClient(session)
  const fromKey = userKeyVaultKeys({ userKey: from }).keyAgreementKey
  const toKey = userKeyVaultKeys({ userKey: to }).keyAgreementKey
  type EncryptedCollection = ReturnType<ReturnType<WasClient['space']>['collection']>
  const swap = async (collection: EncryptedCollection, retire: typeof fromKey, incoming: typeof toKey) => {
    await replaceRecipient({
      collection,
      retire: retire.id as string,
      recipient: ownerRecipient({ keyAgreementKey: incoming }),
      owner: { keyAgreementKey: retire },
      resolveRecipientKey: async () => null,
      pull: async () => {},
    })
    // The retiring key's wraps leave the history too; the incoming key is a
    // recipient of every epoch by now, so nothing becomes unreadable
    const store = collectionDescriptorStore({ collection })
    const read = await store.read()
    if (read) {
      const retired = retire.id as string
      const descriptor = {
        ...read.descriptor,
        epochs: (read.descriptor.epochs ?? []).map((epoch) => ({ ...epoch, recipients: epoch.recipients.filter((entry) => entry.header.kid !== retired) })),
      }
      await store.replace(descriptor, { ifMatch: read.etag })
    }
  }
  const rotated: EncryptedCollection[] = []
  try {
    for (const spaceId of await accountSpaceIds(session)) {
      const space = was.space(spaceId)
      const listing = await space.collections().catch(() => null)
      for (const item of listing?.items ?? []) {
        if ('deleted' in item && item.deleted) {
          continue
        }
        const collection = space.collection(item.id)
        const described = (await collection.describe().catch(() => null)) as { encryption?: { scheme?: string } } | null
        if (described?.encryption?.scheme !== 'edv') {
          continue
        }
        await swap(collection, fromKey, toKey)
        rotated.push(collection)
      }
    }
  } catch (err) {
    for (const collection of rotated) {
      await swap(collection, toKey, fromKey).catch((undo) => console.error('A collection could not be rotated back:', undo))
    }
    throw err
  }
  return rotated.length
}

// Removes a credential from the account and rotates the user key it held:
//
//   1. One log entry drops the removed credential's keys from the document
//      and replaces the account's user key under keyAgreement (signed by the
//      acting credential's update key, unwrapped for this operation alone).
//   2. The removed credential's records are retired from its unlock space
//      under the management capability the catalogue holds (or the space
//      deleted outright when the caller holds its unlock identity).
//   3. Every remaining credential's user-key record is rewritten with the
//      new key under its capability, so its next sign-in opens with it.
//   4. Every encrypted collection of every Space is rotated to the new key.
//   5. The catalogue forgets the credential and is re-sealed to the new key.
//
// Resolves to the session on the new user key (the caller stores it) and
// whether the records were retired. A session open elsewhere keeps the old
// key and signs in again.
export async function removeCredential({
  session,
  acting,
  credential,
  config,
  unlock,
}: {
  session: Session
  acting: CredentialKeys
  credential: RemovableCredential | AccountCredential
  config: Pick<IdentityConfig, 'serverUrl'>
  unlock?: UnlockIdentity
}): Promise<{ session: Session; retired: boolean; rotatedCollections: number }> {
  if (credential.signingMultibase === multibaseOf(session.controller)) {
    throw new Error('The credential this session signed in with cannot be removed from it.')
  }
  if (!credential.updateMultibase) {
    throw new Error('That credential has no update key of its own in the log and cannot be removed.')
  }
  const removed: RemovableCredential = { ...credential, updateMultibase: credential.updateMultibase }
  const catalogue = await readCatalogue(session)
  const removedEntry = catalogue.credentials[credential.signingMultibase]
  const remaining = Object.entries(catalogue.credentials).filter(([signing]) => signing !== credential.signingMultibase)
  const newUserKey = await mintUserKey()

  await removeCredentialFromLog({
    was: await accountClient(session),
    spaceId: session.spaceId,
    did: session.did,
    acting,
    removed,
    userKey: { retire: multibaseOf(session.userKey.id), add: multibaseOf(newUserKey.id) },
  })

  let retired = false
  const { agents, asAccount } = await sessionAgents(session)
  if (unlock) {
    await deleteUnlockSpace({ storageServerUrl: config.serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId })
    retired = true
  } else if (removedEntry) {
    retired = (await retireCredentialRecords({ serverUrl: config.serverUrl, zcapClient: asAccount.zcapClient, spaceId: removedEntry.unlockSpaceId, capability: removedEntry.capability })).retired
  }

  const signer = recordSignerFromAgent({ keyAgent: agents.keyAgent })
  for (const [, entry] of remaining) {
    await rewrapUserKey({
      serverUrl: config.serverUrl,
      zcapClient: asAccount.zcapClient,
      spaceId: entry.unlockSpaceId,
      capability: entry.capability,
      unlockDid: entry.unlockDid,
      userKey: newUserKey,
      signer,
    })
  }
  const rotatedCollections = await rotateCollections({ session, from: session.userKey, to: newUserKey })

  const rotated: Session = { ...session, userKey: newUserKey }
  await updateCatalogue(
    session,
    (current) => {
      delete current.credentials[credential.signingMultibase]
    },
    { sealWith: rotated }
  )
  return { session: rotated, retired, rotatedCollections }
}

// Re-authentication for credential management: opens a credential of this
// account and hands back its keys (the update key among them) for one
// operation. The credential may be any of the account's, not only the one
// the session opened.
export async function confirmWithPassphrase({
  session,
  passphrase,
  config,
}: {
  session: Session
  passphrase: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<CredentialKeys> {
  const opened = await openWithPassphrase({ email: session.email, passphrase, config })
  if (opened.session.did !== session.did) {
    throw Object.assign(new Error('That password belongs to a different account.'), { status: 401 })
  }
  return opened.keys.credential
}

export async function confirmWithPasskey({ session, config }: { session: Session; config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<CredentialKeys> {
  const opened = await openWithPasskey({ config })
  if (opened.session.did !== session.did) {
    throw Object.assign(new Error('That passkey belongs to a different account.'), { status: 401 })
  }
  return opened.keys.credential
}

// ---- recovery ----------------------------------------------------------------
//
// The account's recovery code is a credential like any other: its own signing
// and update keys in the account document, its own unlock space. The back end
// also holds the code (encrypted), so "Forgot your password?" can email it.

const apiUrl = (config: Pick<IdentityConfig, 'apiBase'>, path: string) => `${config.apiBase}${path}`

async function accountRequest(session: Session, config: Pick<IdentityConfig, 'apiBase'>, init: { path: string; method: 'GET' | 'PUT'; json?: unknown }) {
  const { asAccount } = await sessionAgents(session)
  return asAccount.zcapClient.request({
    url: apiUrl(config, init.path),
    method: init.method,
    action: init.method === 'GET' ? 'read' : 'write',
    ...(init.json !== undefined && { json: init.json as Record<string, unknown> }),
  })
}

// Mints a recovery credential for the account and returns its code: adds it
// to the account document (signed by `acting`'s update key), binds its unlock
// space, and stores the code with the back end.
async function mintRecoveryCredential({
  session,
  acting,
  config,
}: {
  session: Session
  acting: CredentialKeys
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<string> {
  const code = mintRecoveryCode()
  const secret = recoverySecretOf(code)!
  const unlock = await deriveUnlockIdentity({ secret, kdf: RECOVERY_KDF })
  await addCredential({ session, acting, config, unlock, kind: 'recovery' })
  await accountRequest(session, config, { path: '/recovery', method: 'PUT', json: { email: session.email, code } })
  return code
}

// After a sign-in: if the account has no recovery code stored with the back
// end, or no catalogued recovery credential in its document (the stored code
// then opens nothing), mint one, replacing any stored code. Idempotent; a
// failure leaves the account as it was (at worst an unused credential in the
// document, which credential management removes), so the caller treats it
// as best effort.
export async function ensureRecoveryCredential({
  session,
  acting,
  config,
}: {
  session: Session
  acting: CredentialKeys
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<string | null> {
  const status = await accountRequest(session, config, { path: `/recovery?email=${encodeURIComponent(session.email)}`, method: 'GET' })
  if ((status.data as { stored?: boolean }).stored && (await listCredentials({ session })).some((credential) => credential.kind === 'recovery')) {
    return null
  }
  // The code is returned for the test scripts only: the wallet never shows
  // it, since it reaches the user by email.
  return mintRecoveryCredential({ session, acting, config })
}

// Asks the back end to email the account's recovery code. The answer is the
// same whether or not the address has an account.
export async function requestRecoveryEmail({ email, config }: { email: string; config: Pick<IdentityConfig, 'apiBase'> }): Promise<void> {
  const res = await fetch(apiUrl(config, '/forgot'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorBody
    throw new Error(body.error ?? 'The recovery email could not be requested.')
  }
}

// Recovers an account with its emailed code and a new passphrase: opens the
// account through the recovery credential, adds the new passphrase as a
// credential, signs in with it, replaces the used recovery code (the old
// one is in a mailbox) with a fresh credential, and removes the old
// recovery credential, which rotates the user key the code could reach.
// Resolves to the session of the new passphrase, on the new user key.
export async function recoverAccount({
  email,
  code,
  newPassphrase,
  config,
}: {
  email: string
  code: string
  newPassphrase: string
  config: IdentityConfig
}): Promise<Session> {
  const secret = recoverySecretOf(code)
  if (!secret) {
    throw Object.assign(new Error('That is not a recovery code.'), { status: 400 })
  }
  const recoveryUnlock = await deriveUnlockIdentity({ secret, kdf: RECOVERY_KDF })
  const { session: viaRecovery, keys: recoveryKeys } = await openCredential({ unlock: recoveryUnlock, email, config })

  // The new passphrase, as a credential of its own
  await addCredential({ session: viaRecovery, acting: recoveryKeys.credential, config, unlock: await openPassphrase(newPassphrase), kind: 'passphrase' })

  // From here on the account is the new passphrase's: replace the used code
  const { session, keys } = await openWithPassphrase({ email, passphrase: newPassphrase, config })
  await mintRecoveryCredential({ session, acting: keys.credential, config })
  const { session: rotated } = await removeCredential({
    session,
    acting: keys.credential,
    credential: await publicKeysOf(recoveryKeys.credential),
    config,
    unlock: recoveryUnlock,
  })
  return rotated
}

export type { Session } from './session'
export type { CredentialKeys } from './keys'
export type { CredentialKind } from './catalogue'
export type { UnlockIdentity } from './unlock'
export { getSession, setSession, clearSession, sessionAgents, sessionEncryption, sessionKeyAgreementKey, sessionSpaceUrl } from './session'
export { passkeySupported, PasskeyCancelledError, PasskeyUnsupportedError } from './passkey'
export { recoverySecretOf } from './recoveryCode'
export { removeCredentialFromLog } from './credentials'
export { acceptedMethodsOf, chooseAccountMethod, accountDid, accountMethodOf, holderSigner, webDidOf } from './holder'
export type { AccountDidMethod, HolderSigner } from './holder'
