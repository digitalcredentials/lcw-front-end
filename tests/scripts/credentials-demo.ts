// Exercises credential management against the deployed back end and PWS
// server on the demo account: lists its credentials, adds one (a stand-in
// for a passkey, from a random secret), checks it opens the account, removes
// it with the passphrase credential's keys, and checks that it is gone from
// the account document, the catalogue, and its unlock space. Idempotent;
// it never touches the account's other credentials.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/credentials-demo.ts
import '@interop/http-client'
import { deriveUnlockIdentity } from '@interop/wallet-core/keyring'
import { resolveDID } from '@interop/did-method-webvh'
import { addCredential, listCredentials, openWithPassphrase, removeCredential } from '../../src/lib/identity'
import { readCredential } from '../../src/lib/identity/unlock'
import { multibaseOf, signingAgents } from '../../src/lib/identity/keys'
import { PASSKEY_KDF } from '../../src/lib/identity/passkey'
import { randomBytes } from '../../src/lib/identity/bytes'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const passphrase = process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou'
const config = {
  apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
  serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  idDomain: process.env.ID_DOMAIN ?? 'id.lcw-sandbox.org',
}
let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}

const { session, keys } = await openWithPassphrase({ email, passphrase, config })
const before = await listCredentials({ session })
check('the account lists its credentials', before.length >= 1, before.map((c) => `${c.kind}${c.current ? '*' : ''}`).join(', '))
const current = before.find((c) => c.current)
check("the session's credential is listed as current and not removable", current !== undefined && !current.removable)
check('the current credential is catalogued as a password', current?.kind === 'passphrase', current?.kind)

// A second credential, standing in for a passkey with a random PRF output
const secret = randomBytes(32)
const unlock = await deriveUnlockIdentity({ secret, kdf: PASSKEY_KDF })
const added = await addCredential({ session, acting: keys.credential, config, unlock, kind: 'passkey', label: 'Script passkey' })
const addedMultibase = multibaseOf((await signingAgents(added.signingSeed)).controllerDid)
const during = await listCredentials({ session })
const row = during.find((c) => c.signingMultibase === addedMultibase)
check('the new credential is listed as a removable passkey with its label', row?.kind === 'passkey' && row?.label === 'Script passkey' && row.removable === true)
check('it is paired with its update key and staged-key commitment', Boolean(row?.updateMultibase) && Boolean(row?.stagedHash))
const opened = await readCredential({ unlock, serverUrl: config.serverUrl })
check('its secret opens the account', opened?.contents.pointer?.did === session.did)

const { retired, session: rotated, rotatedCollections } = await removeCredential({ session, acting: keys.credential, credential: row!, config })
check('it is removed and its unlock records retired under the delegated capability', retired)
check("the account's user key was rotated", rotated.userKey.id !== session.userKey.id, `${rotatedCollections} collection(s) rotated`)
const after = await listCredentials({ session: rotated })
check('it is no longer listed', !after.some((c) => c.signingMultibase === addedMultibase))
check('its secret no longer opens anything', (await readCredential({ unlock, serverUrl: config.serverUrl })) === null)
const resolved = await resolveDID(rotated.did)
const doc = resolved.didDocument as { capabilityInvocation?: unknown[] } | null
check('the account document lists exactly the remaining credentials', doc?.capabilityInvocation?.length === after.length, `${doc?.capabilityInvocation?.length} vs ${after.length}`)
const agreement = (doc as { keyAgreement?: unknown[] } | null)?.keyAgreement?.map((entry) => (typeof entry === 'string' ? entry : (entry as { id?: string }).id)) ?? []
check('the document names the new user key under keyAgreement', agreement.length === 1 && String(agreement[0]).endsWith(`#${rotated.userKey.id.split(':')[2]}`), agreement.join(', '))
const reopened = await openWithPassphrase({ email, passphrase, config })
check("the password credential now opens with the new user key", reopened.session.userKey.id === rotated.userKey.id)
const meta = resolved.didDocumentMetadata as { updateKeys?: unknown[]; nextKeyHashes?: unknown[] }
check('the log authorizes one update key per credential', meta?.updateKeys?.length === after.length, meta?.updateKeys?.length)
check('the log commits exactly two hashes per credential', meta?.nextKeyHashes?.length === after.length * 2, meta?.nextKeyHashes?.length)


process.exit(failures ? 1 : 0)
