// Exercises the identity layer against a deployed PWS server without the
// back end: mints an account's keys, creates a scratch Main Space with the
// coupon, publishes and promotes its did:webvh, binds a passphrase as a
// credential, opens the account again from the passphrase alone, writes and
// reads an encrypted collection with the user key, then deletes everything.
//
//   WAS_URL=https://was.lcw-sandbox.org COUPON=... ID_DOMAIN=id.lcw-sandbox.org \
//     npx tsx tests/scripts/identity-roundtrip.ts
import '@interop/http-client'
import { WasClient } from '@interop/was-client'
import { ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import { resolveDID } from '@interop/did-method-webvh'
import { createAccountLog, publishAccountLog, promoteSpace } from '../../src/lib/identity/account'
import { mintCredentialKeys, mintUserKey, multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed } from '../../src/lib/identity/keys'
import { bindCredential, openPassphrase, readCredential } from '../../src/lib/identity/unlock'
import { sessionAgents, sessionEncryption, sessionKeyAgreementKey, type Session } from '../../src/lib/identity/session'
import { deleteUnlockSpace } from '@interop/wallet-core/keyring'

const serverUrl = (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, '')
const coupon = process.env.COUPON
const idDomain = process.env.ID_DOMAIN ?? 'id.lcw-sandbox.org'
if (!coupon) {
  console.error('Set COUPON to a valid space-creation coupon.')
  process.exit(2)
}

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}

const passphrase = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`
const email = 'roundtrip@example.test'

// --- mint and provision, as registerAccount does ---------------------------
const credential = mintCredentialKeys()
const userKey = await mintUserKey()
const agents = await signingAgents(credential.signingSeed)
const controller = agents.controllerDid
const created = await agents.zcapClient.request({
  url: `${serverUrl}/spaces/`,
  method: 'POST',
  action: 'POST',
  json: { controller, name: 'Roundtrip', type: ['Space'], coupon },
})
const spaceId = (created.data as { id: string }).id
check('scratch Main Space created under the signing did:key', created.status === 201, spaceId)

const was = await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: agents.keyAgent.getSigner() })
const updateKey = await updateKeyFromSeed(credential.updateSeed)
const { did, jsonl } = await createAccountLog({
  idDomain,
  spaceId,
  signingMultibase: multibaseOf(controller),
  userKeyMultibase: multibaseOf(userKey.id),
  updateKey,
  stagedMultibase: await multibaseOfSeed(credential.stagedSeed),
})
await publishAccountLog({ was, spaceId, jsonl })
check('account log published', jsonl.length > 0, did)
const resolved = await resolveDID(did)
check('the DID resolves through the identity domain', resolved.didDocument?.id === did, resolved.didResolutionMetadata?.error)
const doc = resolved.didDocument as { keyAgreement?: unknown[]; capabilityInvocation?: unknown[] } | null
check('the document lists the signing key and the user key', (doc?.capabilityInvocation?.length ?? 0) === 1 && (doc?.keyAgreement?.length ?? 0) === 1)
const promotion = await promoteSpace({ was, spaceId, did, name: 'Roundtrip' })
check('the Main Space is promoted to the did:webvh', promotion === 'promoted', promotion)

const unlock = await openPassphrase(passphrase)
await bindCredential({ unlock, serverUrl, controller, email, pointer: { did, spaceId, host: serverUrl }, keys: { credential, userKey } })
check('the passphrase is bound (unlock space, pointer record, keys record)', true, unlock.spaceId)

// --- open the account from the passphrase alone, as loginWithPassphrase does
const reopened = await readCredential({ unlock: await openPassphrase(passphrase), serverUrl })
check('the credential opens', reopened !== null)
check('the pointer names the account', reopened?.contents.pointer?.did === did && reopened?.contents.pointer?.spaceId === spaceId)
check('the pointer carries the email', reopened?.contents.email === email)
check('the signing seed round-trips', Buffer.from(reopened!.keys.credential.signingSeed).equals(Buffer.from(credential.signingSeed)))
check('the user key round-trips', reopened!.keys.userKey.id === userKey.id && Buffer.from(reopened!.keys.userKey.secret).equals(Buffer.from(userKey.secret)))
const wrong = await readCredential({ unlock: await openPassphrase(`${passphrase}-wrong`), serverUrl })
check('a wrong passphrase finds no account', wrong === null)

// --- a session over the opened keys ------------------------------------------
const session: Session = {
  email,
  did,
  controller,
  serverUrl,
  spaceId,
  signingSeed: reopened!.keys.credential.signingSeed,
  userKey: reopened!.keys.userKey,
}
const { asAccount } = await sessionAgents(session)
const asAccountClient = await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccount.signer, encryption: sessionEncryption(session) })
const space = asAccountClient.space(spaceId)
check('the session reads the promoted Space as the account', (await space.describe())?.controller === did)
const vault = await space.createCollection({ id: 'vault', encryption: { scheme: 'edv' } })
await ensureFirstEpoch({ collection: vault, recipients: [ownerRecipient({ keyAgreementKey: sessionKeyAgreementKey(session) })] })
const added = await vault.add({ hello: 'world' })
const back = (await vault.get(added.id)) as { hello?: string } | null
check('an encrypted collection round-trips under the user key', back?.hello === 'world')

// --- clean up -----------------------------------------------------------------
const gone = await space.deleteWithOutcome()
check('scratch Main Space deleted', gone.outcome === 'deleted')
const unlockGone = await deleteUnlockSpace({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId })
check('unlock space deleted', unlockGone.outcome === 'deleted')
process.exit(failures ? 1 : 0)
