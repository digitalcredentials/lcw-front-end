import { WasClient } from '@interop/was-client'
import { deriveUnlockIdentity } from '@interop/wallet-core/keyring'
import { webvhZcapClient } from '@interop/wallet-core/webvh'
import { createAccountLog, publishAccountLog, promoteSpace } from './account'
import { addCredentialToLog, publicKeysOf } from './credentials'
import { mintCredentialKeys, mintUserKey, multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed, type CredentialKeys } from './keys'
import { PASSKEY_KDF, assertPasskey, registerPasskey } from './passkey'
import { bindCredential, openPassphrase, readCredential, type UnlockIdentity, type UnlockedKeys } from './unlock'
import { sessionAgents, type Session } from './session'

// The identity layer's entry points: registration, sign-in with either kind
// of credential, and adding a passkey. All take their configuration as
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

// Registers an account. In order: the Main Space is created with the
// registration code as coupon (a wrong code stops here); the account's DID
// log is minted and published into the space; the back end records the
// email against the account's did:webvh and emails the confirmation link;
// the space is promoted to the DID; the passphrase is bound as the first
// credential. Every key is minted here at random.
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
  await bindCredential({
    unlock,
    serverUrl: config.serverUrl,
    controller,
    email,
    pointer: { did, spaceId, host: config.serverUrl },
    keys: { credential, userKey },
  })

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
  return {
    session: {
      email: result.email ?? accountEmail,
      coupon: result.token,
      did: pointer.did,
      controller: contents.controller,
      serverUrl: pointer.host,
      spaceId: pointer.spaceId,
      signingSeed: keys.credential.signingSeed,
      userKey: keys.userKey,
    },
    keys,
  }
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
export async function loginWithPasskey({ config }: { config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'> }): Promise<Session> {
  const { prfOutput } = await assertPasskey()
  const unlock = await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF })
  return (await openCredential({ unlock, config })).session
}

// Adds a passkey to the signed-in account as a credential of its own:
// registers it with the browser, mints its signing and update keys, publishes
// them to the account document (signed by the acting credential's update
// key, unwrapped for this operation alone), and binds the passkey's unlock
// space with the pointer record and the sealed keys.
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
  const passkeyKeys = mintCredentialKeys()
  const { asAccount } = await sessionAgents(session)
  const was = await WasClient.fromSigner({ serverUrl: spacesUrl(session.serverUrl), signer: asAccount.signer })
  await addCredentialToLog({ was, spaceId: session.spaceId, did: session.did, acting, added: await publicKeysOf(passkeyKeys) })
  const agents = await signingAgents(passkeyKeys.signingSeed)
  await bindCredential({
    unlock,
    serverUrl: config.serverUrl,
    controller: agents.controllerDid,
    email: session.email,
    pointer: { did: session.did, spaceId: session.spaceId, host: session.serverUrl },
    keys: { credential: passkeyKeys, userKey: session.userKey },
  })
}

export type { Session } from './session'
export type { CredentialKeys } from './keys'
export { getSession, setSession, clearSession, sessionAgents, sessionEncryption, sessionKeyAgreementKey, sessionSpaceUrl } from './session'
export { passkeySupported, PasskeyCancelledError, PasskeyUnsupportedError } from './passkey'
