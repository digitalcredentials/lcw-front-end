import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { securityLoader } from '@interop/security-document-loader'
import jsigs from '@interop/jsonld-signatures'
import { getSessionWASClient } from './was'
import { credentialFrom } from './linkedin'
import { buildPresentation } from './vpRequest'

const documentLoader = securityLoader().build()

// Finds the stored key document for a holder DID in the space's dids
// collection. Entries are EDV-encrypted with opaque ids (claim.ts writes them
// with add()), so the lookup lists the collection and matches on the
// decrypted content's controller; legacy plaintext entries written under
// `<fingerprint>.json` ids are found the same way. The collection holds one
// small key document per claimed credential, so the scan is cheap.
async function findStoredKey(
  session: { client: import('@interop/was-client').WasClient; spaceId: string },
  holderDid: string
): Promise<unknown | null> {
  const dids = session.client.space(session.spaceId).collection('dids')
  const list = await dids.list().catch(() => null)
  for (const item of list?.items ?? []) {
    const stored = await dids.resource(item.id).get().catch(() => null)
    if (!stored || stored instanceof Blob) {
      continue
    }
    const { controller } = stored as { controller?: unknown }
    if (controller === holderDid) {
      return stored
    }
  }
  return null
}

export interface WalletCredential {
  // Where the credential lives, for display and de-duplication
  collectionId: string
  resourceId: string
  // The unwrapped (bare) credential
  credential: Record<string, unknown>
}

// Loads every credential in the space: all collections except Trash and dids,
// each resource unwrapped from its envelope. Unreadable or non-credential
// resources are skipped.
export async function loadWalletCredentials(): Promise<WalletCredential[]> {
  const session = await getSessionWASClient()
  if (!session) {
    throw new Error('Sign in to your wallet first.')
  }
  const space = session.client.space(session.spaceId)
  const list = await space.collections()
  const collections = (list?.items ?? []).filter((c) => !['Trash', 'dids', 'public'].includes(c.id))

  const credentials: WalletCredential[] = []
  for (const collection of collections) {
    const resources = await space.collection(collection.id).list().catch(() => null)
    for (const item of resources?.items ?? []) {
      try {
        const data = await space.collection(collection.id).resource(item.id).get()
        const parsed = data instanceof Blob ? JSON.parse(await data.text()) : data
        const credential = credentialFrom(parsed)
        if (credential) {
          credentials.push({
            collectionId: collection.id,
            resourceId: item.id,
            credential: credential as Record<string, unknown>,
          })
        }
      } catch {
        // not JSON, or unreadable: not a shareable credential
      }
    }
  }
  return credentials
}

// Builds the response presentation for a request. Signed as the holder when
// the request asked for DIDAuthentication with a challenge AND the first
// selected credential's subject DID has its key stored in the space's dids
// collection (one key per claimed credential, saved at claim time); unsigned
// otherwise — the same rule the mobile wallet applies, which also satisfies
// requesters like VerifierPlus that send no challenge and check no proof.
export async function presentationFor({
  credentials,
  didAuth,
  challenge,
  domain,
}: {
  credentials: Record<string, unknown>[]
  didAuth: boolean
  challenge?: string
  domain?: string
}): Promise<Record<string, unknown>> {
  const subject = credentials[0]?.credentialSubject as { id?: unknown } | undefined
  const holderDid = typeof subject?.id === 'string' && subject.id.startsWith('did:key:')
    ? subject.id
    : undefined

  if (!didAuth || !challenge || !holderDid) {
    return buildPresentation({ credentials, holder: holderDid })
  }

  const session = await getSessionWASClient()
  const stored = session ? await findStoredKey(session, holderDid) : null
  if (!stored || stored instanceof Blob) {
    // No stored key for this DID: send unsigned rather than fail the share
    return buildPresentation({ credentials, holder: holderDid })
  }

  const key = await Ed25519VerificationKey.from(
    stored as unknown as Parameters<typeof Ed25519VerificationKey.from>[0]
  )
  const presentation = {
    ...buildPresentation({ credentials, holder: holderDid }),
    // The suite context defines the proof terms; the @interop suite does not
    // add it automatically (same note as claim.ts)
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
  }
  return jsigs.sign(presentation, {
    suite: new Ed25519Signature2020({ signer: key.signer() }),
    purpose: new jsigs.purposes.AuthenticationProofPurpose({ challenge, domain }),
    documentLoader,
  })
}
