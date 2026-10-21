import { WasClient } from '@interop/was-client'
import { createAccountLog, publishAccountLog, promoteSpace } from './account'
import { mintCredentialKeys, mintUserKey, multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed } from './keys'
import { bindCredential, openPassphrase, readCredential } from './unlock'
import type { Session } from './session'

// The identity layer's two entry points, registration and sign-in, over the
// pieces in this directory. Both take their configuration as arguments so
// the same code runs in the wallet (from Vite's env) and in the test scripts
// (from the shell).

export interface IdentityConfig {
  // lcw-back-end, which registers the email and verifies sign-in
  apiBase: string
  // The PWS server the account's spaces live on
  serverUrl: string
  // The identity domain the account's did:webvh names
  idDomain: string
}

export const MAIN_SPACE_NAME = 'Main Space'

interface ErrorBody {
  message?: string
  error?: string
}

// Registers an account. In order: the back end records the email against
// the signing did:key and emails the confirmation link (a wrong registration
// code stops here); the Main Space is created with the code as coupon; the
// account's DID log is minted and published into the space, and the space
// is promoted to it; the passphrase is bound as the first credential. Every
// key is minted here at random.
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

  onStage?.('Registering the account')
  const res = await fetch(`${config.apiBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, did: controller, registrationCode }),
  })
  const body = (await res.json().catch(() => ({}))) as ErrorBody
  if (!res.ok) {
    throw new Error(body.error ?? 'Unable to register. Please try again.')
  }

  onStage?.('Creating your storage space')
  const created = await agents.zcapClient.request({
    url: `${config.serverUrl}/spaces/`,
    method: 'POST',
    action: 'POST',
    json: { controller, name: MAIN_SPACE_NAME, type: ['Space'], coupon: registrationCode },
  })
  const spaceId = (created.data as { id: string }).id

  onStage?.('Publishing your identity')
  const was = await WasClient.fromSigner({ serverUrl: `${config.serverUrl}/spaces/`, signer: agents.keyAgent.getSigner() })
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

// Signs in with a passphrase: derives the unlock identity, opens the
// credential's records, and proves the signing key to the back end. The
// typed email is what the back end verifies the key against; the record's
// copy is kept for sign-ins that have no form to ask on.
export async function loginWithPassphrase({
  email,
  passphrase,
  config,
}: {
  email: string
  passphrase: string
  config: Pick<IdentityConfig, 'apiBase' | 'serverUrl'>
}): Promise<Session> {
  const unlock = await openPassphrase(passphrase)
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
    throw new Error('The stored keys do not match the account.')
  }
  const response = await agents.zcapClient.request({
    url: `${config.apiBase}/login`,
    method: 'POST',
    action: 'write',
    json: { email },
  })
  const result = response.data as LoginResult
  return {
    email: result.email ?? email,
    coupon: result.token,
    did: pointer.did,
    controller: contents.controller,
    serverUrl: pointer.host,
    spaceId: pointer.spaceId,
    signingSeed: keys.credential.signingSeed,
    userKey: keys.userKey,
  }
}

export type { Session } from './session'
export { getSession, setSession, clearSession, sessionAgents, sessionEncryption, sessionKeyAgreementKey, sessionSpaceUrl } from './session'
