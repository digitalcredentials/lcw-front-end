import { PwsClient, type CollectionEncryption, type ServiceDescription, type Space } from '@interop/pws-client'
import { collectionDescriptorStore } from '@interop/pws-client/edv'
import type { EncryptionDescriptorStore } from '@interop/pws-client/edv/core'
import { agentsFromSeed } from '@interop/pws-client/identity'
import type { IKeyAgreementKey } from '@interop/data-integrity-core'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { ZcapClient } from '@interop/ezcap'
import {
  clientAnnexDidParts,
  delegatedClientsPointer,
  ensureGenerationDelegationCurrent,
  ladderSignedGenerationDelegationMinter,
} from '@interop/wallet-core/clientAnnex'
import {
  accountCollectionStores,
  cascadeCollectionsToUserKey,
  collectionEpochsCurrent,
  userKeyRosterLogSigner,
  type CollectionStoreFor,
  type UserKey,
  type UserKeyCascadeResult,
  type userKeyRosterDescriptorStore,
} from '@interop/wallet-core/keys'
import { ID_COLLECTION } from '@interop/wallet-core/space'
import {
  delegatedWebvhLogStore,
  verifyAccountLog,
  type AccountLogSigner,
  type DidWebProjectionStore,
  type VerifiedAccountLog,
  type WebvhIdStore,
} from '@interop/wallet-core/webvh'
import { resealRegistry } from './registry'
import { enrolledAuthority } from './recovery'
import { actingAuthority } from './standing'
import { sessionAgents, sessionEncryption, setSession, type Session } from './session'
import { serviceDescriptionFor } from './service'
import { visitPins } from './pins'

// What a ceremony on the account (approving a wallet, disconnecting one,
// removing a sign-in method) needs from the session, in the two forms the
// two session kinds give it:
//
//   - a transient session signs the account-log entries with the acting
//     credential's ladder, invokes as the annex identity under the
//     generation delegation, and is the credential's roster entry;
//   - a remembered session signs with the enrolled client's update keys,
//     invokes as the account, and is the client's roster entry.
//
// The stores built here are wallet-core's: the account log, the did:web
// projection, the user-key roster, and one descriptor store per encrypted
// collection for the fan-out that follows a user-key rotation.

export interface CeremonyAuthority {
  // The session, replaced in place when a ceremony rotates the user key
  session: Session
  serviceDescription: ServiceDescription
  signer: AccountLogSigner
  // This session's roster entry: the credential's standing key, or the
  // enrolled client's
  clientKeyAgreementKey: IKeyAgreementKey
  // Signs requests to the account Space, and the capability they ride
  zcapClient: ZcapClient
  capability?: IZcap
  idStore: WebvhIdStore
  projectionStore: DidWebProjectionStore
  rosterStore: () => ReturnType<typeof userKeyRosterDescriptorStore>
  // The fan-out's collections: every encrypted collection of the account
  // Space, each with a descriptor store (log-governed or point-state)
  collections: {
    collectionIds: () => Promise<string[]>
    storeFor: (collectionId: string) => EncryptionDescriptorStore
    // Every encrypted collection with its served descriptor, read once
    described: () => Promise<Map<string, DescribedCollection>>
  }
  // The account Space as the current session opens it (encrypted
  // collections decrypt with the user key); built per call so a key
  // adopted mid-ceremony is the one later writes use
  spaceHandle: () => Promise<Space>
  // The verified account log, read once per authority until invalidated
  verified: () => Promise<VerifiedAccountLog>
  invalidate: () => void
}

interface DescribedCollection {
  // How the descriptor is kept: wallet-core's provisioned collections are
  // governed by a history log, this wallet's own (Trash, dids) carry a
  // point-state descriptor
  kind: 'governed' | 'point'
  encryption: CollectionEncryption
}

// The account's encrypted collections with their served descriptors.
async function describeEncryptedCollections(space: Space): Promise<Map<string, DescribedCollection>> {
  const listing = await space.collections()
  const described = await Promise.all(
    (listing?.items ?? []).map(async (item) => {
      const meta = await space.collection(item.id).describe()
      const encryption = meta?.encryption
      return encryption ? ([item.id, { kind: (encryption as { history?: unknown }).history ? 'governed' : 'point', encryption }] as [string, DescribedCollection]) : null
    })
  )
  return new Map(described.filter((entry): entry is [string, DescribedCollection] => entry !== null))
}

function cascadeCollections({ space, governed }: { space: Space; governed: CollectionStoreFor }): CeremonyAuthority['collections'] {
  let described: Map<string, DescribedCollection> | undefined
  const describe = async () => (described ??= await describeEncryptedCollections(space))
  return {
    described: describe,
    collectionIds: async () => [...(await describe()).keys()],
    storeFor: (collectionId) => (described?.get(collectionId)?.kind === 'point' ? collectionDescriptorStore({ collection: space.collection(collectionId) }) : governed(collectionId)),
  }
}

// Brings every encrypted collection onto the session's user key when a
// rotation's fan-out was interrupted (a tab closed mid-disconnection): a
// collection whose current epoch names a superseded generation takes a
// fresh one, one missing the current key's wrap on an earlier epoch is
// escrowed. Run at sign-in; a collection already current costs its
// description read and nothing else. Resolves null when nothing was behind.
export async function sweepCollectionsToUserKey({
  session,
  rosterDescriptor,
  generations,
}: {
  session: Session
  rosterDescriptor: CollectionEncryption
  generations: UserKey[]
}): Promise<UserKeyCascadeResult | null> {
  const authority = await ceremonyAuthority(session)
  const described = await authority.collections.described()
  const ids = [...new Set([...generations.map((generation) => generation.id), session.userKey.id])]
  const behind: string[] = []
  for (const [collectionId, { encryption }] of described) {
    const verdict = collectionEpochsCurrent({ descriptor: encryption, currentGeneration: session.userKey.id, generations: ids })
    if (verdict === 'stale-current-epoch' || verdict === 'escrow-incomplete') {
      behind.push(collectionId)
    } else if (verdict !== 'current') {
      console.warn(`Wallet: the collection "${collectionId}" is keyed to no user key generation this session holds (${verdict}).`)
    }
  }
  if (behind.length === 0) {
    return null
  }
  return cascadeCollectionsToUserKey({
    collectionIds: behind,
    storeFor: authority.collections.storeFor,
    rosterDescriptor,
    clientKeyAgreementKey: authority.clientKeyAgreementKey,
    userKey: session.userKey,
  })
}

export async function ceremonyAuthority(session: Session): Promise<CeremonyAuthority> {
  const serviceDescription = await serviceDescriptionFor(session.serverUrl)
  const { baseServerUrl, spaceId, did } = { baseServerUrl: session.serverUrl, spaceId: session.spaceId, did: session.did }
  let verifiedLog: Promise<VerifiedAccountLog> | undefined
  const authority = {
    verified: () => (verifiedLog ??= verifyAccountLog({ did, pinStore: visitPins })),
    invalidate: () => {
      verifiedLog = undefined
    },
    spaceHandle: async (): Promise<Space> => {
      const current = authority.session
      const { signer, capabilityFor } = await sessionAgents(current)
      const capability = capabilityFor(spaceId)
      const pws = PwsClient.fromSigner({ baseServerUrl, signer, encryption: sessionEncryption(current), serviceDescription })
      return pws.space(spaceId, capability ? { capability } : undefined)
    },
  } as CeremonyAuthority
  authority.session = session
  authority.serviceDescription = serviceDescription
  if (session.kind === 'transient') {
    const acting = await actingAuthority(session)
    const capability = session.generationDelegation
    const plain = new PwsClient({ baseServerUrl, zcapClient: acting.annexZcap, serviceDescription }).space(spaceId, { capability })
    authority.signer = { kind: 'ladder', ladderSeed: session.ladderSeed }
    authority.clientKeyAgreementKey = acting.standingAgents.keyAgreementKey
    authority.zcapClient = acting.annexZcap
    authority.capability = capability
    // The ceremonies use the log store's read, write and pin alone
    authority.idStore = acting.idStore() as unknown as WebvhIdStore
    authority.projectionStore = delegatedWebvhLogStore({ baseServerUrl, spaceId, collectionId: ID_COLLECTION.id, delegation: capability, zcapClient: acting.annexZcap, pinStore: visitPins, serviceDescription })
    authority.rosterStore = () => acting.rosterStore()
    authority.collections = cascadeCollections({
      space: plain,
      governed: accountCollectionStores({ baseServerUrl, spaceId, did, pinStore: visitPins, zcapClient: acting.annexZcap, signer: userKeyRosterLogSigner({ keyAgent: acting.ladderAgent }), capability, serviceDescription }),
    })
    return authority
  }
  const enrolled = await enrolledAuthority(session)
  const idStore = enrolled.idStore()
  authority.signer = { kind: 'enrolled', updateKeys: session.webvhUpdateKeys }
  authority.clientKeyAgreementKey = enrolled.agents.keyAgreementKey
  authority.zcapClient = enrolled.zcapClient
  authority.idStore = idStore
  authority.projectionStore = idStore
  authority.rosterStore = () => enrolled.rosterStore()
  authority.collections = cascadeCollections({
    space: enrolled.pws.space(spaceId),
    governed: accountCollectionStores({ baseServerUrl, spaceId, did, pinStore: visitPins, zcapClient: enrolled.zcapClient, signer: userKeyRosterLogSigner({ keyAgent: enrolled.agents.keyAgent }), serviceDescription }),
  })
  return authority
}

// Adopts a rotated user key mid-ceremony: the registry is re-sealed under
// it while the previous key is still at hand, then the session carries it
// (this tab's stored session included). A remembered browser's client-key
// record keeps the previous key; its next sign-in reads the roster and
// refreshes the record.
export async function adoptUserKey({ authority, userKey }: { authority: CeremonyAuthority; userKey: UserKey }): Promise<void> {
  await resealRegistry({ session: authority.session, userKey })
  const next = { ...authority.session, userKey } as Session
  setSession(next)
  authority.session = next
}

// The standing authority a session can renew the client-annex generation
// delegation with: a transient session's acting credential, or the passkey
// credential a remembered session was opened with.
function standingOf(session: Session): { ladderSeed: Uint8Array; clientSeed: Uint8Array; siblingDelegation: IZcap } | null {
  if (session.kind === 'transient') {
    return { ladderSeed: session.ladderSeed, clientSeed: session.standingClientSeed, siblingDelegation: session.siblingDelegation }
  }
  return session.standing ? { ladderSeed: session.standing.ladderSeed, clientSeed: session.standing.clientSeed, siblingDelegation: session.standing.siblingDelegation } : null
}

// Renews the generation delegation (what every transient session rides)
// when a key about to lose its authority signed it: the client being
// disconnected, or the credential being removed. The replacement is signed
// by the session's own ladder. Resolves the session to continue with: a
// transient one rides the renewed delegation from here on. A session with
// no standing authority (a remembered one opened on a record alone) renews
// nothing.
export async function renewGenerationDelegation({
  session,
  retiringKeyMultibases,
}: {
  session: Session
  retiringKeyMultibases: string[]
}): Promise<{ session: Session; renewed: boolean }> {
  const standing = standingOf(session)
  if (!standing) {
    return { session, renewed: false }
  }
  const serviceDescription = await serviceDescriptionFor(session.serverUrl)
  const verified = await verifyAccountLog({ did: session.did, pinStore: visitPins })
  const clientAnnexDid = delegatedClientsPointer({ doc: verified.doc })
  if (!clientAnnexDid) {
    return { session, renewed: false }
  }
  const { spaceId: annexSpaceId, generationId } = clientAnnexDidParts({ did: clientAnnexDid })
  const standingAgents = await agentsFromSeed({ seed: standing.clientSeed })
  const store = delegatedWebvhLogStore({
    baseServerUrl: session.serverUrl,
    spaceId: annexSpaceId,
    collectionId: generationId,
    delegation: standing.siblingDelegation,
    zcapClient: standingAgents.zcapClient,
    pinStore: visitPins,
    serviceDescription,
  })
  const { delegation, renewed } = await ensureGenerationDelegationCurrent({
    store,
    ladderSeed: standing.ladderSeed,
    mintGenerationDelegation: ladderSignedGenerationDelegationMinter({ accountDid: session.did, ladderSeed: standing.ladderSeed, baseServerUrl: session.serverUrl, spaceId: session.spaceId }),
    expectedDid: clientAnnexDid,
    accountDoc: verified.doc,
    retiringKeyMultibases,
  })
  if (renewed && session.kind === 'transient') {
    const next: Session = { ...session, generationDelegation: delegation }
    setSession(next)
    return { session: next, renewed }
  }
  return { session, renewed }
}
