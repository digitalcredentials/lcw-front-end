// Exercises the identity layer against a deployed PWS server without the
// back end: mints an account's keys, creates a scratch Main Space with the
// coupon, publishes and promotes its did:webvh, binds a passphrase as a
// credential, opens the account again from the passphrase alone, writes and
// reads an encrypted collection with the user key, adds a second credential
// (a stand-in passkey), removes it with the user-key rotation that implies,
// checks what each key can still open, then deletes everything.
//
//   WAS_URL=https://was.lcw-sandbox.org COUPON=... ID_DOMAIN=id.lcw-sandbox.org \
//     npx tsx tests/scripts/identity-roundtrip.ts
import '@interop/http-client'
import { WasClient } from '@interop/was-client'
import { ensureFirstEpoch, ownerRecipient, resolveEpochKeys } from '@interop/was-client/edv'
import type { CollectionEncryption } from '@interop/was-client'
import { resolveDID } from '@interop/did-method-webvh'
import { createAccountLog, publishAccountLog, promoteSpace } from '../../src/lib/identity/account'
import { mintCredentialKeys, mintUserKey, multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed } from '../../src/lib/identity/keys'
import { bindCredential, openPassphrase, readCredential } from '../../src/lib/identity/unlock'
import { addCredential, addRosterRecipient, catalogueCredential, listCredentials, readRoster, recipientOf, removeCredential } from '../../src/lib/identity'
import { PASSKEY_KDF } from '../../src/lib/identity/passkey'
import { randomBytes } from '../../src/lib/identity/bytes'
import { deriveUnlockIdentity, deleteUnlockSpace } from '@interop/wallet-core/keyring'
import { userKeyVaultKeys } from '@interop/wallet-core/keys'
import { sessionAgents, sessionEncryption, sessionKeyAgreementKey, type Session } from '../../src/lib/identity/session'

const serverUrl = (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, '')
const coupon = process.env.COUPON
const idDomain = process.env.ID_DOMAIN ?? 'id.lcw-sandbox.org'
if (!coupon) {
  console.error('Set COUPON to a valid space-creation coupon.')
  process.exit(2)
}
const config = { serverUrl }

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
const projection = (await (await fetch(`https://${idDomain}/${spaceId}/did.json`)).json().catch(() => null)) as { id?: string; alsoKnownAs?: string[] } | null
check('the did:web projection is served beside the log', projection?.id === `did:web:${idDomain}:${spaceId}` && projection?.alsoKnownAs?.includes(did) === true)
const promotion = await promoteSpace({ was, spaceId, did, name: 'Roundtrip' })
check('the Main Space is promoted to the did:webvh', promotion === 'promoted', promotion)

const unlock = await openPassphrase(passphrase)
const { capability } = await bindCredential({ unlock, serverUrl, controller, email, pointer: { did, spaceId, host: serverUrl }, credential })
check('the passphrase is bound (unlock space, pointer and keys records, capability)', Boolean(capability), unlock.spaceId)
const asAccountEarly = (await sessionAgents({ email, did, controller, serverUrl, spaceId, signingSeed: credential.signingSeed, userKey })).asAccount
await addRosterRecipient({ was: await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccountEarly.signer }), spaceId, userKey, recipient: recipientOf(unlock.keyAgreementKey) })
check('the user-key roster names the passphrase as its one recipient', (await readRoster({ was: await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccountEarly.signer }), spaceId }))?.roster.recipients.length === 1)

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
await catalogueCredential({ session, keys: credential, kind: 'passphrase', unlock, capability })
const { asAccount } = await sessionAgents(session)
const asAccountClient = await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccount.signer, encryption: sessionEncryption(session) })
const space = asAccountClient.space(spaceId)
check('the session reads the promoted Space as the account', (await space.describe())?.controller === did)
const vault = await space.createCollection({ id: 'vault', encryption: { scheme: 'edv' } })
await ensureFirstEpoch({ collection: vault, recipients: [ownerRecipient({ keyAgreementKey: sessionKeyAgreementKey(session) })] })
const added = await vault.add({ hello: 'world' })
const back = (await vault.get(added.id)) as { hello?: string } | null
check('an encrypted collection round-trips under the user key', back?.hello === 'world')

// --- a second credential: a passkey stood in for by a random PRF output ------
const prfOutput = randomBytes(32)
const passkeyUnlock = await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF })
const passkeyKeys = await addCredential({ session, acting: credential, config, unlock: passkeyUnlock, kind: 'passkey', label: 'Roundtrip passkey' })
const passkeyAgents = await signingAgents(passkeyKeys.signingSeed)
const grown = await resolveDID(did)
const grownDoc = grown.didDocument as { capabilityInvocation?: unknown[]; verificationMethod?: unknown[] } | null
check("the document lists both credentials' signing keys", (grownDoc?.capabilityInvocation?.length ?? 0) === 2, grown.didResolutionMetadata?.error)
check('the log authorizes both update keys', (grown.didDocumentMetadata as { updateKeys?: unknown[] })?.updateKeys?.length === 2)
const reopenedPasskey = await readCredential({ unlock: await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF }), serverUrl })
check('the passkey credential opens to the same account and user key', reopenedPasskey?.contents.pointer?.did === did && reopenedPasskey?.keys.userKey.id === userKey.id)
check('the roster now names both credentials', (await readRoster({ was: asAccountClient, spaceId }))?.roster.recipients.length === 2)
const passkeySession: Session = { ...session, controller: passkeyAgents.controllerDid, signingSeed: passkeyKeys.signingSeed }
const { asAccount: asAccount2 } = await sessionAgents(passkeySession)
const asPasskeyClient = await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccount2.signer, encryption: sessionEncryption(passkeySession) })
check("the passkey's key reads the Space as the account", (await asPasskeyClient.space(spaceId).describe())?.controller === did)
const backAsPasskey = (await asPasskeyClient.space(spaceId).collection('vault').get(added.id)) as { hello?: string } | null
check('the passkey session decrypts what the passphrase session wrote', backAsPasskey?.hello === 'world')
const listed = await listCredentials({ session })
check('both credentials are catalogued with their kinds', listed.map((c) => c.kind).sort().join(',') === 'passkey,passphrase', listed.map((c) => c.kind).join(','))

// --- remove the passkey: its keys leave the document, the user key rotates --
const passkeyRow = listed.find((c) => c.kind === 'passkey')!
const { session: rotated, retired, rotatedCollections } = await removeCredential({ session, acting: credential, credential: passkeyRow, config })
check("the passkey's unlock records are retired under the delegated capability", retired)
check('the user key was rotated and the vault collection with it', rotated.userKey.id !== session.userKey.id && rotatedCollections === 1, rotatedCollections)
const shrunk = await resolveDID(did)
const shrunkDoc = shrunk.didDocument as { capabilityInvocation?: unknown[]; keyAgreement?: unknown[] } | null
const agreement = shrunkDoc?.keyAgreement?.map((entry) => (typeof entry === 'string' ? entry : (entry as { id?: string }).id)) ?? []
check('the document lists one signing key and the new user key', shrunkDoc?.capabilityInvocation?.length === 1 && agreement.length === 1 && String(agreement[0]).endsWith(`#${multibaseOf(rotated.userKey.id)}`))
check('the removed passkey secret opens nothing', (await readCredential({ unlock: await deriveUnlockIdentity({ secret: prfOutput, kdf: PASSKEY_KDF }), serverUrl })) === null)
const afterRotation = await readCredential({ unlock: await openPassphrase(passphrase), serverUrl })
check('the passphrase credential now opens with the new user key (from the fresh roster)', afterRotation?.keys.userKey.id === rotated.userKey.id)
const freshRoster = (await readRoster({ was: asAccountClient, spaceId }))?.roster
check('the fresh roster carries the new key and names the passphrase alone', freshRoster?.userKey === rotated.userKey.id && freshRoster?.recipients.length === 1 && freshRoster.recipients[0].header.kid === unlock.keyAgreementKey.id)
const vaultDescriptor = ((await space.collection('vault').describe()) as { encryption?: CollectionEncryption } | null)?.encryption
const oldKid = userKeyVaultKeys({ userKey: session.userKey }).keyAgreementKey.id
const newKid = userKeyVaultKeys({ userKey: rotated.userKey }).keyAgreementKey.id
const epochs = vaultDescriptor?.epochs ?? []
check('the vault has a fresh epoch and no epoch names the old user key', epochs.length === 2 && epochs.every((epoch) => !epoch.recipients.some((entry) => entry.header.kid === oldKid)), epochs.length)
check('every epoch names the new user key', epochs.length > 0 && epochs.every((epoch) => epoch.recipients.some((entry) => entry.header.kid === newKid)))
const oldResolves = vaultDescriptor ? await resolveEpochKeys({ encryption: vaultDescriptor, keyAgreementKey: userKeyVaultKeys({ userKey: session.userKey }).keyAgreementKey }).catch(() => null) : null
check('the old user key resolves no epoch key', oldResolves === null, oldResolves ? 'still unwraps' : undefined)
const rotatedClient = await WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: asAccount.signer, encryption: sessionEncryption(rotated) })
const oldRecord = (await rotatedClient.space(spaceId).collection('vault').get(added.id)) as { hello?: string } | null
check('the new user key still reads the record written before the rotation', oldRecord?.hello === 'world')
const addedAfter = await rotatedClient.space(spaceId).collection('vault').add({ hello: 'again' })
const newRecord = (await rotatedClient.space(spaceId).collection('vault').get(addedAfter.id)) as { hello?: string } | null
check('and reads one written after it', newRecord?.hello === 'again')
const remaining = await listCredentials({ session: rotated })
check('the catalogue, re-sealed to the new key, lists the passphrase alone', remaining.length === 1 && remaining[0].kind === 'passphrase' && remaining[0].current)

// --- clean up -----------------------------------------------------------------
const gone = await space.deleteWithOutcome()
check('scratch Main Space deleted', gone.outcome === 'deleted')
const unlockGone = await deleteUnlockSpace({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId })
check('unlock space deleted', unlockGone.outcome === 'deleted')
const passkeyUnlockGone = await deleteUnlockSpace({ storageServerUrl: serverUrl, zcapClient: passkeyUnlock.zcapClient, spaceId: passkeyUnlock.spaceId })
check('the emptied passkey unlock space deleted', passkeyUnlockGone.outcome === 'deleted')
process.exit(failures ? 1 : 0)
