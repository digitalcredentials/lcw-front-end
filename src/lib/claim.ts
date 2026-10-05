import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { securityLoader } from '@interop/security-document-loader'
import jsigs from '@interop/jsonld-signatures'
import { getSessionWASClient } from './was'
import { ensureEncryptedCollection, writeResource } from './edv'
import { getSessionKey } from './auth'
import type { ResourceData } from '@interop/was-client'

const documentLoader = securityLoader().build()

export interface ClaimResult {
  // The issued credential
  credential: Record<string, unknown>
  // The full presentation envelope the issuer returned (what gets stored)
  envelope: Record<string, unknown>
  // The wallet DID the credential is bound to
  holderDid: string
}

// Runs a VC API (VCALM) exchange against the issuer:
//   1. POST {} -> a DIDAuthentication presentation request (challenge/domain)
//   2. generate a fresh did:key and persist it in the space's "dids" collection
//   3. sign a DIDAuth presentation with it and POST it back
//   4. receive the issued credential, bound to that DID
export async function runExchange(exchangeUrl: string): Promise<ClaimResult> {
  const session = await getSessionWASClient()
  if (!session) {
    throw new Error('Sign in to your wallet first, then retry the claim.')
  }

  // 1. The issuer's DIDAuthentication request
  const vprResponse = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  if (!vprResponse.ok) {
    throw new Error(`The issuer rejected the exchange (${vprResponse.status}).`)
  }
  const { verifiablePresentationRequest: vpr } = await vprResponse.json()
  if (!vpr?.challenge || !vpr?.domain) {
    throw new Error('The issuer sent no DIDAuthentication challenge.')
  }

  // 2. A fresh DID for this credential, kept in the space's dids collection
  const key = await Ed25519VerificationKey.generate()
  const holderDid = `did:key:${key.fingerprint()}`
  key.controller = holderDid
  key.id = `${holderDid}#${key.fingerprint()}`

  // The dids collection holds key secrets, so it is end-to-end encrypted:
  // declared with the edv descriptor (set-once; adopted if already present)
  // and written through add(), which mints an opaque EDV id — the key is
  // found again by its content (present.ts scans for the fingerprint).
  const space = session.client.space(session.spaceId)
  const dids = space.collection('dids')
  const storedKeyPair = getSessionKey()
  if (!storedKeyPair) {
    throw new Error('UNAUTHORIZED')
  }
  await ensureEncryptedCollection({ space, id: 'dids', storedKeyPair, name: 'dids' })
  const exported = await key.export({ secretKey: true, includeContext: true })
  await dids.add(exported as unknown as ResourceData)

  // 3. DIDAuth: prove control of the DID against the issuer's challenge
  // The suite context defines the proof terms (challenge, domain); the
  // @interop suite does not add it automatically
  const presentation = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ],
    type: ['VerifiablePresentation'],
    holder: holderDid
  }
  const signedVp = await jsigs.sign(presentation, {
    suite: new Ed25519Signature2020({ signer: key.signer() }),
    purpose: new jsigs.purposes.AuthenticationProofPurpose({
      challenge: vpr.challenge,
      domain: vpr.domain
    }),
    documentLoader
  })

  // 4. The issued credential comes back in a presentation envelope
  const issueResponse = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifiablePresentation: signedVp })
  })
  const result = await issueResponse.json().catch(() => ({}))
  if (!issueResponse.ok) {
    throw new Error(result.error ?? `The issuer rejected the presentation (${issueResponse.status}).`)
  }
  const envelope = result.verifiablePresentation
  const credential = envelope?.verifiableCredential?.[0]
  if (!credential) {
    throw new Error('The issuer returned no credential.')
  }
  return { credential, envelope, holderDid }
}

// Saves the issued credential (in its presentation envelope, the same shape
// other wallet contents use) into the chosen collection.
// Saves the claimed credential, returning the id it landed under (the given
// name in a plaintext collection; a minted EDV id in an encrypted one).
export async function saveCredential(
  collectionId: string,
  name: string,
  envelope: Record<string, unknown>
): Promise<{ id: string }> {
  const session = await getSessionWASClient()
  if (!session) {
    throw new Error('Sign in to your wallet first.')
  }
  return writeResource({
    collection: session.client.space(session.spaceId).collection(collectionId),
    name,
    body: envelope as unknown as ResourceData,
  })
}
