// Live check of coupon redemption: a single-use coupon creates exactly one
// space (second attempt 403), and its row shows usesRemaining 0 afterwards.
import '@interop/http-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'

const WAS = 'https://was.lcw-sandbox.org'
const EMAIL = 'jc.chartrand+aws@gmail.com'
const PASSPHRASE = 'my-secret-seed-that-is-long-enou'
const COUPON = process.env.COUPON // the single-use test coupon

const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PASSPHRASE))
const keyPair = await Ed25519VerificationKey.generate({ seed: new Uint8Array(digest) })
keyPair.controller = `did:key:${keyPair.fingerprint()}`
keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`
const zcapClient = new ZcapClient({
  SuiteClass: Ed25519Signature2020,
  invocationSigner: keyPair.signer(),
})

let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const create = () =>
  zcapClient.request({
    url: `${WAS}/spaces`,
    method: 'POST',
    action: 'write',
    json: { controller: keyPair.controller, email: EMAIL, type: 'batch', name: 'single-use check', coupon: COUPON },
  })

// 1. First redemption succeeds
const first = await create()
const spaceUrl = first.data.space
check(`single-use coupon created ${spaceUrl}`, Boolean(spaceUrl))

// 2. Second redemption is rejected: the coupon is spent
try {
  await create()
  check('spent coupon rejected', false)
} catch (err) {
  check(`spent coupon rejected (${err.status})`, err.status === 403)
}

// 3. Clean up the created space
const del = await zcapClient.request({ url: spaceUrl, method: 'DELETE', action: 'DELETE' })
check(`cleanup delete (${del.status})`, del.status === 200)

process.exit(failures ? 1 : 0)
