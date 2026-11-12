import type { CollectionEncryption } from '@interop/pws-client'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { selfEnrollClientCore } from '@interop/wallet-core/clientAnnex'
import { accountControllerResolver, delegatedWebvhLogStore, verifyAccountLog, webvhZcapClient, isWebvhDid, type VerifiedAccountLog } from '@interop/wallet-core/webvh'
import { unwrapUserKeyGenerations, userKeyRosterDescriptorStore, userKeyRosterLogSigner, type ClientKeyRecord, type UserKey } from '@interop/wallet-core/keys'
import { checkUserKeyRosterAtLogin } from '@interop/wallet-core/clients'
import { ID_COLLECTION } from '@interop/wallet-core/space'
import type { UnlockCredential } from './credential'
import { pointerLocation, type StandingRecord } from './records'
import type { RememberedSession } from './session'
import { serviceDescriptionFor } from './service'
import { visitPins } from './pins'
import { defaultClientKeyStore, type ClientKeyStore } from './clientKeyRecord'

// The remembered session: how a passkey enters the account on a browser
// that enrolled (decision 1: the only remembered browser is a passkey one).
// The passkey's PRF output derives the credential; the credential's unlock
// identity opens this browser's client-key record; the enrolled client's
// key, which the account document lists, then signs as the account itself.
//
// A browser with no record (a passkey synced to a new device, or one whose
// record was wiped) self-enrolls from the credential's standing record: two
// account-log entries through the credential's bridge delegation, the
// first roster read through the credential's own wrap, and the new client's
// escrow, with the record written before the entry that publishes the
// client (persist before publish), so a tab closing midway leaves a record
// the next login resumes rather than a client only a disconnect could
// remove.

export interface RememberedEntry {
  session: Omit<RememberedSession, 'email' | 'coupon'>
  verified: VerifiedAccountLog
  enrolled: boolean
  // The user-key roster's descriptor as read (null when the account serves
  // none), and every generation of the user key it wraps to this client,
  // oldest first (empty when the roster could not be unwrapped)
  rosterDescriptor: CollectionEncryption | null
  userKeyGenerations: UserKey[]
}

export async function openRememberedSession({
  credential,
  found,
  serverUrl,
  store = defaultClientKeyStore,
}: {
  credential: UnlockCredential
  found: StandingRecord
  serverUrl: string
  store?: ClientKeyStore
}): Promise<RememberedEntry> {
  const { unlock, standing } = credential
  const { pointer } = found
  if (!pointer.did || !isWebvhDid(pointer.did)) {
    throw new Error('The account this credential points at was never completed.')
  }
  const did = pointer.did
  const { serverUrl: baseServerUrl, spaceId } = pointerLocation(pointer)
  if (baseServerUrl !== serverUrl) {
    throw new Error(`The account lives on ${baseServerUrl}, not on the configured server.`)
  }
  const serviceDescription = await serviceDescriptionFor(baseServerUrl)
  let verified = await verifyAccountLog({ did, pinStore: visitPins })

  let record = await store.load(unlock)
  if (record && record.pointerDid && record.pointerDid !== did) {
    // Residue of another account under a reused secret
    await store.remove(unlock.spaceId)
    record = null
  }
  let enrolled = false
  if (!record || record.pending || !record.userKey) {
    if (!found.ladderSeed) {
      throw new Error('This credential cannot enroll a browser: its record carries no standing authority.')
    }
    const resume = record?.pending?.ceremony === 'self-enrollment' && record.webvhUpdateKeys ? { clientSeed: record.clientSeed, webvhUpdateKeys: record.webvhUpdateKeys, builtOnHead: record.pending.builtOnHead } : undefined
    const result = await selfEnrollClientCore({
      pointer,
      ladderSeed: found.ladderSeed,
      credentialKeyAgreementKey: standing.agents.keyAgreementKey,
      serviceDescription,
      logStore: delegatedWebvhLogStore({
        baseServerUrl,
        spaceId,
        collectionId: ID_COLLECTION.id,
        delegation: found.delegation,
        zcapClient: standing.agents.zcapClient,
        pinStore: visitPins,
        serviceDescription,
      }),
      ...(resume && { resume }),
      // Persist before publish: the pending record goes down before the
      // entry that publishes the client
      onCommitted: async ({ builtOnHead, clientSeed, webvhUpdateKeys }) => {
        await store.save(unlock, { clientSeed, webvhUpdateKeys, controller: found.controller, pointerDid: did, pending: { ceremony: 'self-enrollment', builtOnHead } })
      },
    })
    record = { clientSeed: result.clientSeed, userKey: result.userKey, webvhUpdateKeys: result.webvhUpdateKeys, controller: found.controller, pointerDid: result.did }
    await store.save(unlock, record)
    enrolled = true
    // The enrollment appended to the account log: the roster below is
    // read against the document as it stands now
    verified = await verifyAccountLog({ did, pinStore: visitPins })
  }

  const agents = await agentsFromSeed({ seed: record.clientSeed })
  const zcapClient = webvhZcapClient({ keyAgent: agents.keyAgent, did })
  const rosterStore = userKeyRosterDescriptorStore({
    baseServerUrl,
    zcapClient,
    spaceId,
    serviceDescription,
    resolveController: accountControllerResolver({ did, pinStore: visitPins, log: verified.log }),
    pinStore: visitPins,
    signer: userKeyRosterLogSigner({ keyAgent: agents.keyAgent }),
  })
  // The roster as it stands now: a rotation since the last visit is
  // adopted and the record refreshed
  const roster = await checkUserKeyRosterAtLogin({
    store: rosterStore,
    userKey: record.userKey,
    clientKeyAgreementKey: agents.keyAgreementKey,
    onRosterRead: async (adopted) => {
      record = { ...record!, userKey: adopted.userKey }
      await store.save(unlock, record)
    },
  })
  const userKey = roster?.userKey ?? record.userKey
  if (!userKey) {
    throw new Error('The account has no user-key roster.')
  }
  if (!record.webvhUpdateKeys) {
    throw new Error('The client-key record carries no update keys.')
  }
  const userKeyGenerations = roster ? await unwrapUserKeyGenerations({ descriptor: roster.descriptor, clientKeyAgreementKey: agents.keyAgreementKey }).catch(() => [] as UserKey[]) : []
  return {
    session: {
      kind: 'remembered',
      did,
      serverUrl: baseServerUrl,
      spaceId,
      userKey,
      unlockSpaceId: unlock.spaceId,
      clientSeed: record.clientSeed,
      webvhUpdateKeys: record.webvhUpdateKeys,
      // The passkey credential's own ladder authority, when its record
      // carries the standing layout
      ...(found.ladderSeed &&
        found.delegatedClients && {
          standing: { ladderSeed: found.ladderSeed, clientSeed: standing.clientSeed, bridgeDelegation: found.delegation, siblingDelegation: found.delegatedClients },
        }),
    },
    verified,
    enrolled,
    rosterDescriptor: roster?.descriptor ?? null,
    userKeyGenerations,
  }
}

export type { ClientKeyRecord }
