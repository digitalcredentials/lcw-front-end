import { PwsClient, type CollectionEncryption } from '@interop/pws-client'
import { agentsFromSeed } from '@interop/pws-client/identity'
import {
  ClientAnnexGenerationUnavailableError,
  attributePointerEntryRung,
  clientAnnexDidParts,
  delegatedClientsDelegationSpaceId,
  delegatedClientsPointer,
  embeddedGenerationDelegation,
  enrollTransientClient,
  ensureCredentialClientAnnexGeneration,
  ladderSignedGenerationDelegationMinter,
  mintPointedClientAnnexGeneration,
  movePointerAsLadder,
  standingRungHashesOf,
  type ClientAnnexWriteStore,
} from '@interop/wallet-core/clientAnnex'
import { accountControllerResolver, clientSigningKeyMultibase, delegatedWebvhLogStore, didKeyZcapClient, verifyAccountLog, webvhZcapClient, isWebvhDid, type PublishedWebvhLog, type VerifiedAccountLog } from '@interop/wallet-core/webvh'
import { readUserKeyRoster, unwrapUserKeyGenerations, userKeyRosterDescriptorStore, userKeyRosterLogSigner, type UserKey } from '@interop/wallet-core/keys'
import { ID_COLLECTION, plaintextCollection } from '@interop/wallet-core/space'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { UnlockCredential } from './credential'
import { bindStandingRecord, pointerLocation, type StandingRecord } from './records'
import type { TransientSession } from './session'
import { serviceDescriptionFor } from './service'
import { visitPins } from './pins'
import { randomBytes } from './bytes'
import { generationPublicMark, recallMark, rememberMark } from './marks'

// The transient session: how a standing credential (a passphrase, a
// recovery code) enters the account for one visit, FreeWallet's way. The
// visit mints a key held in memory only, enrolls it into the account's
// client-annex generation (one log entry, written through the credential's
// sibling delegation and signed by the credential's ladder rung), and from
// then on signs as `<clientAnnexDid>#<key>` under the generation
// delegation the annex document embeds. The user key is read from the
// credential's own roster wrap; nothing is escrowed, and the roster never
// gains the visit's key.

export type TransientRefusal =
  | 'unpromoted-account'
  | 'no-delegated-clients'
  | 'no-clientAnnex-generation'
  | 'no-generation-delegation'
  | 'no-user-key-wrap'
  | 'no-roster'

export class TransientLoginUnavailableError extends Error {
  reason: TransientRefusal
  constructor({ reason, message, cause }: { reason: TransientRefusal; message?: string; cause?: unknown }) {
    super(message ?? `This credential cannot open the account right now (${reason}).`, cause === undefined ? undefined : { cause })
    this.name = 'TransientLoginUnavailableError'
    this.reason = reason
  }
}

// A generation store that names an absent generation (collected, or never
// minted) as the typed refusal rather than an unexplained read failure.
function refuseMissingGeneration(store: ClientAnnexWriteStore): ClientAnnexWriteStore {
  return {
    pin: store.pin,
    async getIdResourceRaw(options) {
      const result = await store.getIdResourceRaw(options)
      if (result === undefined) {
        throw new TransientLoginUnavailableError({
          reason: 'no-clientAnnex-generation',
          message: 'The delegated-clients generation this account points at is not published.',
        })
      }
      return result
    },
    putIdResource: store.putIdResource.bind(store),
  }
}

export interface TransientEntry {
  session: Omit<TransientSession, 'email' | 'coupon'>
  verified: VerifiedAccountLog
  // The user-key roster's descriptor as read, and every generation of the
  // user key it wraps to the credential, oldest first (empty when they
  // could not be unwrapped)
  rosterDescriptor: CollectionEncryption
  userKeyGenerations: UserKey[]
}

// Every visit appends one entry to the pointed generation's log, and each
// entry carries the generation's whole document, so the log grows with the
// square of the visits since the generation was minted. The resolvers that
// read it (this server's, the back end's) cap a log at 1 MB, which a
// generation reaches after a few dozen visits. wallet-core replaces a
// generation on a 90-day cadence at remembered logins, which a password-
// only account never reaches, so a visit that finds the pointed generation
// at this many entries mints a fresh one first, restating the standing
// credentials the old one admitted, and points the account at it.
const GENERATION_RENEWAL_ENTRIES = 24

// Mints a fresh generation from this credential's ladder seed, through the
// record's sibling delegation, and moves the account's pointer to it with
// a bridge-signed entry: the same block the readiness ensure runs when a
// credential is not admitted, run here because the generation is long.
async function renewGeneration({
  baseServerUrl,
  spaceId,
  annexSpaceId,
  accountDid,
  accountLog,
  ladderSeed,
  standingZcap,
  sibling,
  bridge,
  superseded,
  serviceDescription,
}: {
  baseServerUrl: string
  spaceId: string
  annexSpaceId: string
  accountDid: string
  accountLog: VerifiedAccountLog['log']
  ladderSeed: Uint8Array
  standingZcap: UnlockCredential['standing']['agents']['zcapClient']
  sibling: IZcap
  bridge: IZcap
  superseded: PublishedWebvhLog
  serviceDescription: Awaited<ReturnType<typeof serviceDescriptionFor>>
}): Promise<{ clientAnnexDid: string; generationDelegation: IZcap }> {
  const idStore = delegatedWebvhLogStore({ baseServerUrl, spaceId, collectionId: ID_COLLECTION.id, delegation: bridge, zcapClient: standingZcap, pinStore: visitPins, serviceDescription })
  await attributePointerEntryRung({ ladderSeed, log: accountLog })
  const generation = await mintPointedClientAnnexGeneration({
    pws: new PwsClient({ baseServerUrl, zcapClient: standingZcap, serviceDescription }),
    baseServerUrl,
    spaceId: annexSpaceId,
    controller: accountDid,
    ladderSeed,
    capability: sibling,
    standingRungHashes: await standingRungHashesOf(superseded),
    mintGenerationDelegation: ladderSignedGenerationDelegationMinter({ accountDid, ladderSeed, baseServerUrl, spaceId }),
    point: (clientAnnexDid: string) => movePointerAsLadder({ idStore, ladderSeed, clientAnnexDid, accountDid }),
    pinStore: visitPins,
  })
  return { clientAnnexDid: generation.clientAnnexDid, generationDelegation: generation.generationDelegation }
}

// Enters the account a standing record points at, for this visit.
export async function openTransientSession({
  credential,
  found,
  serverUrl,
  accountLog,
}: {
  credential: UnlockCredential
  found: StandingRecord
  serverUrl: string
  // The account log's head a signup that just ran ended standing on, read
  // instead of fetching did.jsonl again
  accountLog?: PublishedWebvhLog
}): Promise<TransientEntry> {
  const { standing } = credential
  const { pointer } = found
  if (!found.ladderSeed) {
    throw new Error('The unlock record carries no standing authority.')
  }
  if (!pointer.did || !isWebvhDid(pointer.did)) {
    throw new TransientLoginUnavailableError({ reason: 'unpromoted-account', message: 'The account this credential points at was never completed. Sign up again.' })
  }
  const accountDid = pointer.did
  const ladderSeed = found.ladderSeed
  const { serverUrl: baseServerUrl, spaceId } = pointerLocation(pointer)
  if (baseServerUrl !== serverUrl) {
    throw new Error(`The account lives on ${baseServerUrl}, not on the configured server.`)
  }
  const serviceDescription = await serviceDescriptionFor(baseServerUrl)
  const seeded = accountLog !== undefined && accountLog.did === accountDid ? accountLog : undefined

  // 1. The account log, verified under the visit's pins
  let verified = await verifyAccountLog({ did: accountDid, pinStore: visitPins, ...(seeded && { published: seeded }) })

  // 2. The client-annex generation: the ladder-signed ensure that mints or
  // renews what the visit needs (the record's bridge and sibling delegations
  // included, re-sealed into the record when renewed)
  const standingZcap = standing.agents.zcapClient
  let sibling: IZcap
  let bridge: IZcap = found.delegation
  let annexSpaceId: string
  let healed: IZcap | undefined
  let generationLog: PublishedWebvhLog | undefined
  // Whether this visit minted or renewed the generation it enrolls into
  let generationFresh = false
  try {
    const outcome = await ensureCredentialClientAnnexGeneration({
      baseServerUrl,
      spaceId,
      account: { did: accountDid, doc: verified.doc, log: verified.log },
      ladderSeed,
      standingClient: { did: standing.clientDid, zcapClient: standingZcap },
      serviceDescription,
      bootstrapPwsFor: ({ keyAgent }) => new PwsClient({ baseServerUrl, zcapClient: didKeyZcapClient({ keyAgent }), serviceDescription }),
      delegation: found.delegation,
      idStoreFor: ({ delegation }) =>
        delegatedWebvhLogStore({ baseServerUrl, spaceId, collectionId: ID_COLLECTION.id, delegation, zcapClient: standingZcap, pinStore: visitPins, serviceDescription }),
      onRebindRecord: async ({ delegation, delegatedClients }) => {
        await bindStandingRecord({
          credential,
          serverUrl: baseServerUrl,
          controller: found.controller,
          email: found.email,
          pointer,
          delegation,
          delegatedClients,
          ladderSeed,
          delegateManagementTo: accountDid,
          priorCreatedAt: found.createdAt,
        })
      },
      ...(found.delegatedClients && { delegatedClients: found.delegatedClients }),
    })
    annexSpaceId = clientAnnexDidParts({ did: outcome.clientAnnexDid }).spaceId
    sibling = outcome.delegatedClients
    bridge = outcome.delegation
    healed = outcome.generationDelegation
    generationLog = outcome.generationLog
    if (outcome.generationMinted || outcome.spaceMinted) {
      // The pointer moved: the enrollment must read the fresh log
      generationFresh = true
      verified = await verifyAccountLog({ did: accountDid, pinStore: visitPins })
    } else if (generationLog && generationLog.log.length >= GENERATION_RENEWAL_ENTRIES) {
      // The pointed generation has grown long: a fresh one takes its place
      // before this visit enrolls (see GENERATION_RENEWAL_ENTRIES)
      const renewed = await renewGeneration({
        baseServerUrl,
        spaceId,
        annexSpaceId,
        accountDid,
        accountLog: verified.log,
        ladderSeed,
        standingZcap,
        sibling,
        bridge,
        superseded: generationLog,
        serviceDescription,
      })
      healed = renewed.generationDelegation
      generationLog = undefined
      generationFresh = true
      verified = await verifyAccountLog({ did: accountDid, pinStore: visitPins })
    }
  } catch (err) {
    if (!(err instanceof ClientAnnexGenerationUnavailableError) && (err as { name?: string })?.name !== 'ClientAnnexGenerationUnavailableError') {
      throw err
    }
    // The fallback: the record's own sibling and the pointed generation
    const recordSibling = found.delegatedClients
    const siblingSpaceId = recordSibling ? delegatedClientsDelegationSpaceId({ delegation: recordSibling }) : undefined
    if (!recordSibling || !siblingSpaceId) {
      throw new TransientLoginUnavailableError({ reason: 'no-delegated-clients', cause: err })
    }
    if (!delegatedClientsPointer({ doc: verified.doc })) {
      throw new TransientLoginUnavailableError({ reason: 'no-clientAnnex-generation', cause: err })
    }
    sibling = recordSibling
    annexSpaceId = siblingSpaceId
  }

  // 3. The per-visit key, enrolled into the generation
  const visitSeed = randomBytes(32)
  const { keyAgent } = await agentsFromSeed({ seed: visitSeed })
  let firstDoc: VerifiedAccountLog['doc'] | undefined = verified.doc
  const { clientAnnexDid, doc: annexDoc } = await enrollTransientClient({
    readAccountDocument: async () => {
      if (firstDoc) {
        const doc = firstDoc
        firstDoc = undefined
        return doc
      }
      verified = await verifyAccountLog({ did: accountDid, pinStore: visitPins })
      return verified.doc
    },
    storeForGenerationId: (generationId) =>
      refuseMissingGeneration(
        delegatedWebvhLogStore({ baseServerUrl, spaceId: annexSpaceId, collectionId: generationId, delegation: sibling, zcapClient: standingZcap, pinStore: visitPins, serviceDescription })
      ),
    ladderSeed,
    transientKeyMultibase: clientSigningKeyMultibase({ keyAgent }),
    // The generation delegation is taken as embedded: the ensure above
    // installs and renews it, and a generation with none refuses before
    // the entry publishes
    mintGenerationDelegation: async () => {
      throw new TransientLoginUnavailableError({ reason: 'no-generation-delegation' })
    },
    ...(generationLog && { published: generationLog }),
  })
  const generationDelegation = embeddedGenerationDelegation({ doc: annexDoc }) ?? healed
  if (!generationDelegation) {
    throw new TransientLoginUnavailableError({ reason: 'no-generation-delegation' })
  }
  // The generation's log is a did:webvh log a resolver outside this server
  // (the back end verifying a sign-in signed as the annex) reads over
  // HTTPS, so it is made world-readable, as the account's `id` is, before
  // the session goes on to sign in: a generation minted a moment ago (a
  // recovery login's) is otherwise unreadable to the back end when its
  // sign-in arrives. Best effort through the sibling delegation; a refusal
  // changes nothing here. Once per generation on this browser: the write
  // is a no-op after the first, at the cost of a signed request a visit.
  const generationId = clientAnnexDidParts({ did: clientAnnexDid }).generationId
  if (generationFresh || recallMark(generationPublicMark(generationId)) !== '1') {
    await plaintextCollection({
      pws: new PwsClient({ baseServerUrl, zcapClient: standingZcap, serviceDescription }),
      spaceId: annexSpaceId,
      collectionId: generationId,
      capability: sibling,
    })
      .setPublic()
      .then(() => rememberMark(generationPublicMark(generationId), '1'))
      .catch(() => undefined)
  }

  // 4. The user key, from the credential's standing roster wrap, read as
  // the annex identity under the generation delegation
  const annexZcap = webvhZcapClient({ keyAgent, did: clientAnnexDid })
  const rosterStore = userKeyRosterDescriptorStore({
    baseServerUrl,
    zcapClient: annexZcap,
    spaceId,
    serviceDescription,
    resolveController: accountControllerResolver({ did: accountDid, pinStore: visitPins, log: verified.log }),
    pinStore: visitPins,
    signer: userKeyRosterLogSigner({ keyAgent }),
    capability: generationDelegation,
  })
  let roster
  try {
    roster = await readUserKeyRoster({ store: rosterStore, clientKeyAgreementKey: standing.agents.keyAgreementKey })
  } catch (err) {
    if ((err as { name?: string })?.name === 'UserKeyRosterUnwrapError') {
      throw new TransientLoginUnavailableError({ reason: 'no-user-key-wrap', cause: err })
    }
    throw err
  }
  if (!roster) {
    throw new TransientLoginUnavailableError({ reason: 'no-roster' })
  }
  const userKeyGenerations = await unwrapUserKeyGenerations({ descriptor: roster.descriptor, clientKeyAgreementKey: standing.agents.keyAgreementKey }).catch(() => [] as UserKey[])

  return {
    rosterDescriptor: roster.descriptor,
    userKeyGenerations,
    session: {
      kind: 'transient',
      did: accountDid,
      serverUrl: baseServerUrl,
      spaceId,
      userKey: roster.userKey,
      unlockSpaceId: credential.unlock.spaceId,
      clientAnnexDid,
      visitSeed,
      generationDelegation,
      ladderSeed,
      standingClientSeed: standing.clientSeed,
      bridgeDelegation: bridge,
      siblingDelegation: sibling,
    },
    verified,
  }
}
