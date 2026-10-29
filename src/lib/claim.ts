import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { securityLoader } from '@interop/security-document-loader'
import jsigs from '@interop/jsonld-signatures'
import { getSessionWASClient, getSessionWASClientFor } from './was'
import { ensureEncryptedCollection, writeResource } from './edv'
import { IssuerError, PlainError, outsideText } from './errors'
import { getSession, acceptedMethodsOf, chooseAccountMethod, holderSigner, type HolderSigner } from './identity'
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
//   2. choose the holder DID: the account's did:webvh or did:web projection
//      when the request's acceptedMethods allow one (any credential of the
//      account then signs for it later), else a fresh did:key kept in the
//      space's "dids" collection
//   3. sign a DIDAuth presentation with it and POST it back
//   4. receive the issued credential, bound to that DID
export async function runExchange(exchangeUrl: string): Promise<ClaimResult> {
  const session = await getSessionWASClient()
  const account = getSession()
  if (!session || !account) {
    throw new Error('UNAUTHORIZED')
  }

  // 1. The issuer's DIDAuthentication request
  const vprResponse = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch((err) => {
    throw new IssuerError('The issuer could not be reached.', undefined, err)
  })
  if (!vprResponse.ok) {
    throw new IssuerError(`The issuer rejected the exchange (${vprResponse.status}).`, vprResponse.status)
  }
  const { verifiablePresentationRequest: vpr } = await vprResponse.json()
  if (!vpr?.challenge || !vpr?.domain) {
    // The message stays plain; the request itself is kept for diagnosis
    console.warn('Exchange request is missing its challenge or domain:', vpr)
    throw new PlainError("The issuer's request was incomplete, so we couldn't collect the credential. Go back to the issuer's page and try again.")
  }

  // 2. The holder DID and its signer
  const method = chooseAccountMethod(acceptedMethodsOf(vpr))
  let holderDid: string
  let signer: HolderSigner
  if (method) {
    ;({ did: holderDid, signer } = await holderSigner(account, method))
  } else {
    // A fresh DID for this credential, kept in the space's dids collection.
    // The collection holds key secrets, so it is end-to-end encrypted:
    // declared with the edv descriptor (set-once; adopted if already
    // present) and written through add(), which mints an opaque EDV id; the
    // key is found again by its content (present.ts scans for the DID).
    const key = await Ed25519VerificationKey.generate()
    holderDid = `did:key:${key.fingerprint()}`
    key.controller = holderDid
    key.id = `${holderDid}#${key.fingerprint()}`
    const space = session.client.space(session.spaceId)
    const dids = space.collection('dids')
    await ensureEncryptedCollection({ space, id: 'dids', name: 'dids' })
    const exported = await key.export({ secretKey: true, includeContext: true })
    await dids.add(exported as unknown as ResourceData)
    signer = key.signer()
  }

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
    suite: new Ed25519Signature2020({ signer }),
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
  }).catch((err) => {
    throw new IssuerError('The issuer could not be reached.', undefined, err)
  })
  const result = await issueResponse.json().catch(() => ({}))
  if (!issueResponse.ok) {
    throw new IssuerError(outsideText(result.error) ?? `The issuer rejected the presentation (${issueResponse.status}).`, issueResponse.status)
  }
  const envelope = result.verifiablePresentation
  const credential = envelope?.verifiableCredential?.[0]
  if (!credential) {
    throw new PlainError("The issuer didn't send a credential. Go back to the issuer's page and try again.")
  }
  return { credential, envelope, holderDid }
}

// Saves the issued credential (in its presentation envelope, the same shape
// other wallet contents use) into the chosen collection.
// Saves the claimed credential, returning the id it landed under (the given
// name in a plaintext collection; a minted EDV id in an encrypted one). The
// optional spaceUrl targets any of the account's credential spaces; without
// it the session's default space is used.
export async function saveCredential(
  collectionId: string,
  name: string,
  envelope: Record<string, unknown>,
  spaceUrl?: string
): Promise<{ id: string }> {
  const session = spaceUrl
    ? await getSessionWASClientFor(spaceUrl)
    : await getSessionWASClient()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  return writeResource({
    collection: session.client.space(session.spaceId).collection(collectionId),
    name,
    body: envelope as unknown as ResourceData,
  })
}
