// Seeds a standing account's Space with what the deployed tests look for:
// the LCW Experience Badge, tagged "University of Toronto"
// (tests/helpers/seedAccount.ts). Idempotent: a credential already there
// keeps its tags and gains that one if missing. With --reset, every stored
// credential, Trash record and public copy is deleted first, so the Space
// holds the badge alone afterwards.
//
// The tests no longer need this: each run makes, seeds and deletes an
// account of its own (tests/helpers/testAccount.ts). It is for an account
// kept by hand, such as one to show the wallet with.
//
// The account itself must exist first (tests/scripts/register-demo.ts, and
// its confirmation email clicked). The account is opened the way the wallet
// signs in with a password: a transient session riding the account's
// generation delegation.
//
//   DEMO_EMAIL=... DEMO_PASSPHRASE=... npx tsx tests/scripts/seed-demo.ts [--reset]
//
// Environment: DEMO_EMAIL and DEMO_PASSPHRASE (required), API_BASE and
// WAS_URL (default to the sandbox).
import '@interop/http-client'
import { PUBLIC_CREDENTIALS_COLLECTION } from '@interop/wallet-core/space'
import { loginWithPassphrase, setSession } from '../../src/lib/identity'
import { deleteResource, discardTrashItem, listResourceIds, listTrash } from '../../src/lib/credentials'
import { SEED_TAG, accountSpace, seedBadge } from '../helpers/seedAccount'

const email = process.env.DEMO_EMAIL
const passphrase = process.env.DEMO_PASSPHRASE
if (!email || !passphrase) {
  console.error("Set DEMO_EMAIL and DEMO_PASSPHRASE to the account's email and passphrase.")
  process.exit(2)
}
const reset = process.argv.includes('--reset')

const session = await loginWithPassphrase({
  email,
  passphrase,
  config: {
    apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
    serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  },
})
setSession(session)
console.log(`space ${session.serverUrl}/space/${session.spaceId} (${session.did})`)

if (reset) {
  const space = await accountSpace(session)
  // Every resource goes, read or not: what is there is not looked at
  const rids = await listResourceIds(space)
  for (const rid of rids) {
    await deleteResource(space, rid)
  }
  const trash = await listTrash(space)
  for (const item of trash) {
    await discardTrashItem(space, item)
  }
  const copies = (await space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' }).list().catch(() => null))?.items ?? []
  for (const copy of copies) {
    await space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' }).resource(copy.id).delete()
  }
  console.log(`reset: ${rids.length} credential resource(s), ${trash.length} Trash record(s), ${copies.length} public cop${copies.length === 1 ? 'y' : 'ies'} deleted`)
}

const { name, cid, outcome } = await seedBadge(session)
console.log(
  outcome === 'added'
    ? `added "${name}" as ${cid}, tagged "${SEED_TAG}"`
    : outcome === 'tagged'
      ? `tagged "${name}" "${SEED_TAG}"`
      : `"${name}" is already there as ${cid}, tagged "${SEED_TAG}"`
)
console.log('done')
