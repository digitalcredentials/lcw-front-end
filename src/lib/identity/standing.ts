import { agentsFromSeed } from '@interop/pws-client/identity'
import {
  clientAnnexDidParts,
  commitClientAnnexRung,
  ladderVmAgent,
  ladderVmZcapClient,
  mintDelegatedClientsDelegation,
} from '@interop/wallet-core/clientAnnex'
import { generateLadderSeed, publishUnlockKey } from '@interop/wallet-core/unlock'
import { delegateLogWrite, recordedDelegationFields } from '@interop/wallet-core/recovery'
import { accountControllerResolver, delegatedWebvhLogStore, keyAgreementCommitment, ladderRung, webvhZcapClient } from '@interop/wallet-core/webvh'
import { addUserKeyRosterRecipient, userKeyRosterDescriptorStore, userKeyRosterLogSigner } from '@interop/wallet-core/keys'
import { ID_COLLECTION } from '@interop/wallet-core/space'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { UnlockCredential } from './credential'
import { bindStandingRecord, pointerOf } from './records'
import type { TransientSession } from './session'
import { serviceDescriptionFor } from './service'
import { visitPins } from './pins'
import type { StandingUnlockFields } from './unlockMethods'

// Adding a standing credential (a passkey, a new passphrase) to the
// account from a transient session: FreeWallet's ladder branch of the
// standing establishment. The acting credential, the one that opened the
// session, signs everything: its ladder VM signs the account-log entry
// that publishes the new credential's keys and the roster append that
// escrows the user key to it, its sibling delegation reaches the annex
// generation the new credential's rung is committed into, and the visit's
// annex identity invokes the roster under the generation delegation.
//
// Order: the new credential's record first (inert until its ladder VM is
// published, so a tear leaves an orphan a retry overwrites), the annex
// rung commit, the account-log entry, then the roster escrow (licensed only
// once the entry stands).

export interface EstablishedCredential {
  unlockSpaceId: string
  manageCapability?: IZcap
  standingFields: StandingUnlockFields
  ladderSeed: Uint8Array
  delegation: IZcap
  delegatedClients: IZcap
  unlockKeyAgreementKeyId?: string
  unlockKeyAgreementKeyMultibase?: string
}

// The acting authority of a transient session, rebuilt from the seeds it
// keeps.
export async function actingAuthority(session: TransientSession) {
  const serviceDescription = await serviceDescriptionFor(session.serverUrl)
  const standingAgents = await agentsFromSeed({ seed: session.standingClientSeed })
  const ladderAgent = await ladderVmAgent({ ladderSeed: session.ladderSeed })
  const visit = await agentsFromSeed({ seed: session.visitSeed })
  const annexZcap = webvhZcapClient({ keyAgent: visit.keyAgent, did: session.clientAnnexDid })
  const { spaceId: annexSpaceId, generationId } = clientAnnexDidParts({ did: session.clientAnnexDid })
  return {
    serviceDescription,
    standingAgents,
    ladderAgent,
    annexZcap,
    annexSpaceId,
    generationId,
    // The account log, written through the acting credential's bridge
    idStore: () =>
      delegatedWebvhLogStore({
        baseServerUrl: session.serverUrl,
        spaceId: session.spaceId,
        collectionId: ID_COLLECTION.id,
        delegation: session.bridgeDelegation,
        zcapClient: standingAgents.zcapClient,
        pinStore: visitPins,
        serviceDescription,
      }),
    // The pointed annex generation, written through the sibling
    generationStore: () =>
      delegatedWebvhLogStore({
        baseServerUrl: session.serverUrl,
        spaceId: annexSpaceId,
        collectionId: generationId,
        delegation: session.siblingDelegation,
        zcapClient: standingAgents.zcapClient,
        pinStore: visitPins,
        serviceDescription,
      }),
    // The user-key roster, invoked as the annex identity under the
    // generation delegation and signed by the acting ladder VM
    rosterStore: () =>
      userKeyRosterDescriptorStore({
        baseServerUrl: session.serverUrl,
        zcapClient: annexZcap,
        spaceId: session.spaceId,
        serviceDescription,
        resolveController: accountControllerResolver({ did: session.did, pinStore: visitPins }),
        pinStore: visitPins,
        signer: userKeyRosterLogSigner({ keyAgent: ladderAgent }),
        capability: session.generationDelegation,
      }),
  }
}

export async function addStandingCredential({
  session,
  credential,
  lowEntropy,
  email,
  coupon = session.coupon,
}: {
  session: TransientSession
  credential: UnlockCredential
  // A passphrase publishes its key-agreement key as a hash commitment; a
  // passkey's PRF-derived key publishes verbatim
  lowEntropy: boolean
  email?: string
  // The coupon the new credential's unlock Space is created with: the
  // session's (the registration token) unless given
  coupon?: string
}): Promise<EstablishedCredential> {
  const acting = await actingAuthority(session)
  const { standing } = credential
  const pointer = pointerOf({ serverUrl: session.serverUrl, spaceId: session.spaceId, did: session.did })

  // The new credential's own ladder, whose VM signs its delegations
  const ladderSeed = generateLadderSeed()
  const rung0 = await ladderRung({ ladderSeed, index: 0 })
  const boundZcap = await ladderVmZcapClient({ accountDid: session.did, ladderSeed })
  const boundAgent = await ladderVmAgent({ ladderSeed })
  const delegation = await delegateLogWrite({ zcapClient: boundZcap, pointer, recoveryClientDid: standing.clientDid })
  const delegatedClients = await mintDelegatedClientsDelegation({
    zcapClient: boundZcap,
    baseServerUrl: session.serverUrl,
    clientAnnexSpaceId: acting.annexSpaceId,
    controller: standing.clientDid,
  })

  // 1. The record, in the standing layout
  const bound = await bindStandingRecord({
    credential,
    serverUrl: session.serverUrl,
    coupon,
    controller: boundAgent.id.split('#')[0],
    email,
    pointer,
    delegation,
    delegatedClients,
    ladderSeed,
    delegateManagementTo: session.did,
  })

  // 2. The new credential's annex rung, committed into the pointed
  // generation by the acting rung
  await commitClientAnnexRung({ store: acting.generationStore(), boundLadderSeed: ladderSeed, actingLadderSeed: session.ladderSeed, expectedDid: session.clientAnnexDid })

  // 3. The account-log entry: the key-agreement publication and rung 0's
  // hash, signed by the acting ladder VM
  await publishUnlockKey({
    idStore: acting.idStore(),
    signer: { kind: 'ladder', ladderSeed: session.ladderSeed },
    unlockKeys: {
      keyAgreement: lowEntropy
        ? { commitment: await keyAgreementCommitment({ keyAgreementKeyMultibase: standing.keyAgreementKeyMultibase }) }
        : { publicKeyMultibase: standing.keyAgreementKeyMultibase },
      updateKeyMultibase: rung0.keyMultibase,
    },
    ladderSeed,
    expectedDid: session.did,
  })

  // 4. The escrow: the new credential's key into every roster epoch
  await addUserKeyRosterRecipient({
    store: acting.rosterStore(),
    recipient: { id: standing.recipientKid, publicKeyMultibase: standing.keyAgreementKeyMultibase },
    ownerKeyAgreementKey: acting.standingAgents.keyAgreementKey,
  })

  return {
    unlockSpaceId: bound.unlockSpaceId,
    ...(bound.manageCapability && { manageCapability: bound.manageCapability }),
    ladderSeed,
    delegation,
    delegatedClients,
    ...(bound.unlockKeyAgreementKeyId && { unlockKeyAgreementKeyId: bound.unlockKeyAgreementKeyId }),
    ...(bound.unlockKeyAgreementKeyMultibase && { unlockKeyAgreementKeyMultibase: bound.unlockKeyAgreementKeyMultibase }),
    standingFields: {
      rosterKid: standing.recipientKid,
      keyAgreementKeyMultibase: standing.keyAgreementKeyMultibase,
      updateKeyMultibase: rung0.keyMultibase,
      ...recordedDelegationFields({ delegation, delegatedClients }),
      unlockClientDid: standing.clientDid,
      ...(bound.unlockKeyAgreementKeyId && { unlockKeyAgreementKeyId: bound.unlockKeyAgreementKeyId }),
      ...(bound.unlockKeyAgreementKeyMultibase && { unlockKeyAgreementKeyMultibase: bound.unlockKeyAgreementKeyMultibase }),
    },
  }
}
