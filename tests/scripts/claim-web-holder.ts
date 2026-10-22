// Claims a badge from the deployed test issuer as the demo account's did:web
// projection, the way src/lib/claim.ts does when an issuer accepts did:web:
// signs in, checks the projection the identity domain serves, creates an
// exchange, signs the DIDAuth presentation with the session's key under the
// did:web, and checks that the issuer verified it (it resolves the did:web
// over HTTPS) and bound the credential to that DID. Nothing is stored.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/claim-web-holder.ts [issuer-api-base]
import '@interop/http-client'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { securityLoader } from '@interop/security-document-loader'
import jsigs from '@interop/jsonld-signatures'
import { openWithPassphrase, acceptedMethodsOf, chooseAccountMethod, holderSigner, webDidOf } from '../../src/lib/identity'

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
const issuerApi = (process.argv[2] ?? 'https://ko29d8ljta.execute-api.us-east-1.amazonaws.com').replace(/\/+$/, '')
let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}

const { session } = await openWithPassphrase({ email, passphrase, config })
const webDid = webDidOf(session)
check('the account has a did:web projection id', webDid.startsWith(`did:web:${config.idDomain}:`), webDid)

// The projection, as a did:web resolver fetches it
const projectionUrl = `https://${config.idDomain}/${session.spaceId}/did.json`
const projection = (await (await fetch(projectionUrl)).json().catch(() => null)) as { id?: string; alsoKnownAs?: string[]; verificationMethod?: { id: string }[] } | null
check('the identity domain serves did.json', projection !== null, projectionUrl)
check('the projection is the did:web, also known as the did:webvh', projection?.id === webDid && projection?.alsoKnownAs?.includes(session.did) === true)
check("the projection lists the session's key under the did:web", projection?.verificationMethod?.some((vm) => vm.id === `${webDid}#${session.controller.slice('did:key:'.length)}`) === true)

// The exchange, as the wallet's claim runs it
const created = (await (await fetch(`${issuerApi}/workflows/lcw-sandbox-badge/exchanges`, { method: 'POST' })).json()) as {
  exchangeId: string
  verifiablePresentationRequest: { interact: { service: { serviceEndpoint: string }[] } }
}
const exchangeUrl = created.verifiablePresentationRequest.interact.service[0].serviceEndpoint
const { verifiablePresentationRequest: vpr } = (await (await fetch(exchangeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as {
  verifiablePresentationRequest: Record<string, unknown> & { challenge: string; domain: string }
}
const accepted = acceptedMethodsOf(vpr)
check('the issuer states the DID methods it accepts', accepted.length > 0, accepted.join(', ') || 'none')
const method = chooseAccountMethod(accepted) ?? 'web'
check('the wallet would answer with an account DID', chooseAccountMethod(accepted) !== null, method)

const { did: holderDid, signer } = await holderSigner(session, method)
const signedVp = await jsigs.sign(
  {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
  },
  {
    suite: new Ed25519Signature2020({ signer }),
    purpose: new jsigs.purposes.AuthenticationProofPurpose({ challenge: vpr.challenge, domain: vpr.domain }),
    documentLoader: securityLoader().build(),
  }
)
const res = await fetch(exchangeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verifiablePresentation: signedVp }) })
const result = (await res.json().catch(() => ({}))) as { error?: string; verifiablePresentation?: { verifiableCredential?: { credentialSubject?: { id?: string } }[] } }
check(`the issuer verified the DIDAuth signed as the ${method} holder`, res.ok, res.ok ? res.status : `${res.status} ${result.error ?? ''}`)
const credential = result.verifiablePresentation?.verifiableCredential?.[0]
check('the credential is bound to the account DID', credential?.credentialSubject?.id === holderDid, credential?.credentialSubject?.id)
process.exit(failures ? 1 : 0)
