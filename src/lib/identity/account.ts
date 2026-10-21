import { createDID, deriveNextKeyHash, logToJsonlString } from '@interop/did-method-webvh'
import { ensurePromotedSpaceController } from '@interop/wallet-core/genesis'
import type { WasClient } from '@interop/was-client'
import type { UpdateKey } from './keys'

// The account's did:webvh: its log lives in the Main Space's world-readable
// `id` collection and is served through the identity domain, so the DID is
// did:webvh:{scid}:{idDomain}:{spaceId}. The document lists one signing key
// per credential under every signing relationship and the account's user
// key under keyAgreement; the log's update keys are the credentials'.

const ID_COLLECTION = 'id'
const LOG_RESOURCE = 'did.jsonl'

export async function createAccountLog({
  idDomain,
  spaceId,
  signingMultibase,
  userKeyMultibase,
  updateKey,
  stagedMultibase,
}: {
  idDomain: string
  spaceId: string
  signingMultibase: string
  userKeyMultibase: string
  updateKey: UpdateKey
  stagedMultibase: string
}): Promise<{ did: string; jsonl: string }> {
  const signing = [`#${signingMultibase}`]
  const { did, log } = await createDID({
    address: idDomain,
    paths: [spaceId],
    signer: updateKey.logSigner,
    updateKeys: [updateKey.didKey],
    nextKeyHashes: [await deriveNextKeyHash(stagedMultibase)],
    verificationMethods: [
      { type: 'Multikey', publicKeyMultibase: signingMultibase },
      { type: 'Multikey', publicKeyMultibase: userKeyMultibase },
    ],
    vmIdFragment: 'multibase',
    portable: true,
    authentication: signing,
    assertionMethod: signing,
    capabilityInvocation: signing,
    capabilityDelegation: signing,
    keyAgreement: [`#${userKeyMultibase}`],
  })
  return { did, jsonl: logToJsonlString(log) }
}

// Publishes the log into the Space's `id` collection and makes that
// collection world-readable, which is what lets the identity domain serve
// it to resolvers. `was` signs as the Space's current controller.
export async function publishAccountLog({ was, spaceId, jsonl }: { was: WasClient; spaceId: string; jsonl: string }): Promise<void> {
  const id = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' })
  await id.resource(LOG_RESOURCE).put(new TextEncoder().encode(jsonl), { contentType: 'text/jsonl' })
  await id.setPublic()
}

// Moves the Space's controller from the signing did:key to the did:webvh.
// Signed by the did:key, which the server accepts because the document
// lists that key. From then on requests to the Space sign as the account.
export function promoteSpace({ was, spaceId, did, name }: { was: WasClient; spaceId: string; did: string; name: string }) {
  return ensurePromotedSpaceController({ was, wasAsClient: was, spaceId, did, name })
}
