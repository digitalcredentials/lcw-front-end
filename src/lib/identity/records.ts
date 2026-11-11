import { ensureUnlockSpace, getUnlockKeyring, putUnlockKeyring, type AccountPointer } from '@interop/wallet-core/keyring'
import { UNLOCK_MANAGEMENT_ACTIONS, unwrapUnlockRecord, wrapUnlockRecord, type UnlockRecordProofState } from '@interop/wallet-core/unlock'
import type { CredentialAnchoredBindResult } from '@interop/wallet-core/clientAnnex'
import { baseServerUrlOf, spaceIdOfUrl, spaceUrlById } from '@interop/pws-client/paths/layout'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { UnlockCredential } from './credential'
import { provisionUnlockSpace } from './provision'
import { serviceDescriptionFor } from './service'

// A credential's standing unlock record: `keyring/keyring.json` in the
// credential's unlock Space, wallet-core's signed and sealed record in the
// standing layout (the account pointer, the bridge delegation that lets the
// credential write the account log, the sibling delegation into the
// client-annex Space, the ladder seed, and a MAC binding the lot to the
// credential). A record written here opens in FreeWallet and the reverse,
// because both wallets write it with wallet-core's codec.

export interface StandingRecord {
  controller: string
  email?: string
  pointer: AccountPointer
  createdAt: string
  delegation: IZcap
  delegatedClients?: IZcap
  ladderSeed?: Uint8Array
  proofState: UnlockRecordProofState
}

// How long the management capability an unlock Space delegates to the
// account stays valid (wallet-core's standing zcap lifetime).
const MANAGEMENT_TTL_MS = 365 * 24 * 60 * 60 * 1000

export const unlockSpaceUrl = (serverUrl: string, spaceId: string) => spaceUrlById({ baseServerUrl: serverUrl, spaceId })

// The account pointer's parts in the forms the session keeps (no trailing
// slash on the server URL).
export function pointerLocation(pointer: AccountPointer): { serverUrl: string; spaceId: string } {
  return { serverUrl: baseServerUrlOf(pointer.spaceUrl).replace(/\/+$/, ''), spaceId: spaceIdOfUrl(pointer.spaceUrl) }
}

export function pointerOf({ serverUrl, spaceId, did }: { serverUrl: string; spaceId: string; did?: string }): AccountPointer {
  return { ...(did !== undefined && { did }), spaceUrl: spaceUrlById({ baseServerUrl: serverUrl, spaceId }) }
}

// A record stamp strictly later than any it supersedes: a re-bind must
// supersede the bind before it even on a fast clock.
function nextCreatedAt(advancePast: Array<string | undefined>): string {
  let stamp = Date.now()
  for (const prior of advancePast) {
    const ms = prior === undefined ? NaN : Date.parse(prior)
    if (Number.isFinite(ms) && ms >= stamp) {
      stamp = ms + 1
    }
  }
  return new Date(stamp).toISOString()
}

// The credential's record, unwrapped and binding-verified, or null when the
// credential's unlock Space holds none (a wrong passphrase derives an
// identity whose Space does not exist; a removed credential's is gone).
export async function fetchStandingRecord({ credential, serverUrl }: { credential: UnlockCredential; serverUrl: string }): Promise<StandingRecord | null> {
  const { unlock, standing } = credential
  const record = await getUnlockKeyring({
    baseServerUrl: serverUrl,
    zcapClient: unlock.zcapClient,
    serviceDescription: await serviceDescriptionFor(serverUrl),
    spaceId: unlock.spaceId,
  })
  if (record === null) {
    return null
  }
  if ((record as { bridge?: unknown }).bridge === undefined) {
    throw new Error('The credential carries a plain pointer record, which this wallet no longer opens. Sign in with FreeWallet or another credential and add the passphrase again.')
  }
  const { contents, proofState } = await unwrapUnlockRecord({
    record,
    keyAgreementKey: unlock.keyAgreementKey,
    keyResolver: unlock.keyResolver,
    expectedKeyMultibase: unlock.recordSigner.keyMultibase,
    // The pointer that comes back is credential-authenticated: the binding
    // is checked under the MAC key only the credential derives
    bindingMacKey: standing.bindingMacKey,
  })
  return { ...contents, proofState }
}

// Delegates the unlock Space's management (reads, writes and deletes below
// it) from the unlock identity, the Space's controller, to the account, so
// a session signed as the account can retire the credential's record later
// without its secret.
export async function delegateUnlockManagement({ credential, serverUrl, to }: { credential: UnlockCredential; serverUrl: string; to: string }): Promise<IZcap> {
  const { unlock } = credential
  return unlock.zcapClient.delegate({
    invocationTarget: unlockSpaceUrl(serverUrl, unlock.spaceId),
    controller: to,
    allowedActions: [...UNLOCK_MANAGEMENT_ACTIONS],
    expires: new Date(Date.now() + MANAGEMENT_TTL_MS),
  })
}

// Writes the credential's standing record: provisions its unlock Space on
// the first bind (with the coupon when one is given, else by id, which the
// server accepts for a Space whose id derives from the signing unlock
// did:key), wraps the record in the standing layout, and delegates the
// management capability when an account to delegate it to is named. The
// result is what wallet-core's credential-anchored establishment expects
// from its `bindRecord` hook.
export async function bindStandingRecord({
  credential,
  serverUrl,
  coupon,
  controller,
  email,
  pointer,
  delegation,
  delegatedClients,
  ladderSeed,
  delegateManagementTo,
  priorCreatedAt,
}: {
  credential: UnlockCredential
  serverUrl: string
  // The server's space-creation coupon; absent, the Space is created by id
  coupon?: string
  // The controller the record names: the ladder VM's bare did:key, the
  // bootstrap identity re-derivable from the credential alone
  controller: string
  email?: string
  pointer: AccountPointer
  delegation: IZcap
  delegatedClients?: IZcap
  ladderSeed: Uint8Array
  delegateManagementTo?: string
  // The previous bind's stamp: this record supersedes it, and its presence
  // says the unlock Space already exists
  priorCreatedAt?: string
}): Promise<CredentialAnchoredBindResult> {
  const { unlock, standing } = credential
  const createdAt = nextCreatedAt([priorCreatedAt])
  const record = await wrapUnlockRecord({
    controller,
    email,
    pointer,
    delegation,
    ...(delegatedClients && { delegatedClients }),
    ladderSeed,
    keyAgreementKey: unlock.keyAgreementKey,
    signer: unlock.recordSigner,
    bindingMacKey: standing.bindingMacKey,
    createdAt,
  })
  const serviceDescription = await serviceDescriptionFor(serverUrl)
  if (priorCreatedAt === undefined) {
    await provisionUnlockSpace({ credential, serverUrl, coupon })
    await ensureUnlockSpace({ baseServerUrl: serverUrl, zcapClient: unlock.zcapClient, serviceDescription, spaceId: unlock.spaceId, controller: unlock.agent.id })
  }
  await putUnlockKeyring({ baseServerUrl: serverUrl, zcapClient: unlock.zcapClient, serviceDescription, spaceId: unlock.spaceId, record })
  const manageCapability = delegateManagementTo ? await delegateUnlockManagement({ credential, serverUrl, to: delegateManagementTo }) : undefined
  return {
    createdAt,
    unlockSpaceId: unlock.spaceId,
    ...(manageCapability && { manageCapability }),
    unlockKeyAgreementKeyId: unlock.keyAgreementKey.id,
    unlockKeyAgreementKeyMultibase: unlock.keyAgreementKey.publicKeyMultibase,
  }
}
