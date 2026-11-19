import { preflightUnlockCredentialRetirement, retireUnlockCredential, type StandingUnlockKeys } from '@interop/wallet-core/unlock'
import { keyAgreementCommitment } from '@interop/wallet-core/webvh'
import { adoptUserKey, ceremonyAuthority, renewGenerationDelegation, retireAnnexInventory, type AnnexRetirement } from './authority'
import { deleteClientKeyRecord } from './clientKeyRecord'
import { updateRegistry } from './registry'
import type { Session } from './session'
import { emptyRegistry, removeMethod, type UnlockMethod } from './unlockMethods'
import { deleteManagedUnlockSpace } from './unlockSpaceDeletion'

// Removing a sign-in method (a passkey, a recovery code, a passphrase
// another one replaced): wallet-core's unlock-credential retirement. One
// account-log entry strikes the credential's key-agreement publication and
// its ladder from the account document, the user key is rotated and every
// encrypted collection takes an epoch under the new key (the session adopts
// it as it goes). Then this wallet takes the credential's annex rung out of
// the client annex, deletes the credential's unlock Space through a
// DELETE-only child of the management capability the credential delegated
// to the account when it was added, drops the registry entry, and forgets
// any client-key record this browser kept under it.
//
// The credential that opened the session cannot be removed from it: its
// ladder signs the retirement, and no entry can remove the key that signed
// it (wallet-core's rule). A passphrase is replaced, never removed on its
// own, so an account always keeps one.

export type NotRemovableReason = 'acting' | 'inventory'

export class MethodNotRemovableError extends Error {
  reason: NotRemovableReason
  constructor(reason: NotRemovableReason, message: string) {
    super(message)
    this.name = 'MethodNotRemovableError'
    this.reason = reason
  }
}

export interface RetirementOutcome {
  // The session to continue with: it adopted the rotated user key
  session: Session
  // `partial` when a collection could not take its epoch, or the unlock
  // Space is still there; the next retirement or sign-in resumes the first
  completion: 'complete' | 'partial'
  unlockSpace: 'deleted' | 'not-found' | 'kept'
  // What became of the credential's annex rung: struck from the pointed
  // generation, never in it, left behind by a fresh generation, or not
  // reached (the rung may still be admitted)
  annex: AnnexRetirement
}

// The public inventory the retirement strikes from the account document:
// the credential's key-agreement publication (a passphrase publishes a
// commitment, every other method the key itself) and its recorded rung.
async function unlockKeysOf(method: UnlockMethod): Promise<StandingUnlockKeys> {
  const { keyAgreementKeyMultibase, updateKeyMultibase } = method as { keyAgreementKeyMultibase?: string; updateKeyMultibase?: string }
  if (!keyAgreementKeyMultibase || !updateKeyMultibase) {
    throw new MethodNotRemovableError('inventory', 'This sign-in method was listed without the keys its removal needs. Sign in with it and add it again, then remove it.')
  }
  return {
    keyAgreement: method.type === 'passphrase' ? { commitment: await keyAgreementCommitment({ keyAgreementKeyMultibase }) } : { publicKeyMultibase: keyAgreementKeyMultibase },
    updateKeyMultibase,
  }
}

// Deletes the credential's unlock Space through its management capability
// (unlockSpaceDeletion.ts). A method listed without one keeps its Space.
async function deleteUnlockSpaceOf({ session, method }: { session: Session; method: UnlockMethod }): Promise<'deleted' | 'not-found' | 'kept'> {
  if (!method.manageCapability) {
    return 'kept'
  }
  return deleteManagedUnlockSpace({ session, unlockSpaceId: method.unlockSpaceId, manageCapability: method.manageCapability })
}

// Retires a sign-in method's credential and removes the method.
// `retiredLadderSeed`: the credential's own ladder seed, when the caller
// holds it (the password a replacement retires, typed for this session),
// so its annex rung is struck rather than the generation replaced.
export async function retireMethod({ session, method, retiredLadderSeed }: { session: Session; method: UnlockMethod; retiredLadderSeed?: Uint8Array }): Promise<RetirementOutcome> {
  if (method.unlockSpaceId === session.unlockSpaceId) {
    throw new MethodNotRemovableError('acting', 'This is the sign-in method you signed in with, so it cannot remove itself. Sign in another way to remove it.')
  }
  const unlockKeys = await unlockKeysOf(method)
  // 1. The generation delegation, renewed first when the retiring
  // credential's ladder signed it: a password session would otherwise lose
  // its own authority with the credential's keys
  const delegationKeyId = (method as { delegationKeyId?: string }).delegationKeyId
  const renewed = await renewGenerationDelegation({ session, retiringKeyMultibases: delegationKeyId ? [delegationKeyId] : [] })
  const authority = await ceremonyAuthority(renewed.session)
  // 2. The preflight: a credential whose ladder cannot be claimed from the
  // recorded rung is refused before anything is published
  await preflightUnlockCredentialRetirement({ idStore: authority.idStore, unlockKeys, expectedDid: session.did })
  // 3. The retirement: the document strike, the user-key rotation, the
  // collections' epochs
  const result = await retireUnlockCredential({
    idStore: authority.idStore,
    signer: authority.signer,
    unlockKeys,
    projectionStore: authority.projectionStore,
    expectedDid: session.did,
    verb: 'removing a sign-in method',
    rosterStore: authority.rosterStore(),
    userKey: authority.session.userKey,
    clientKeyAgreementKey: authority.clientKeyAgreementKey,
    onUserKeyAdopted: async ({ userKey }) => adoptUserKey({ authority, userKey }),
    collections: authority.collections,
  })
  authority.invalidate()
  // 4. The client annex, best effort after the essential remedy above: run
  // once the document no longer lists the credential, so it cannot admit
  // itself again. A swap from a transient session moves the session to the
  // fresh generation, which the steps below then sign under.
  let annex: AnnexRetirement = 'skipped'
  try {
    const retired = await retireAnnexInventory({ session: authority.session, ...(retiredLadderSeed && { retiredLadderSeed }) })
    authority.session = retired.session
    annex = retired.annex
  } catch (err) {
    console.warn("The removed method's annex rung could not be taken out of the client annex:", err)
  }
  // 5. The unlock Space, best effort: a Space left behind holds a record
  // nothing opens any more
  let unlockSpace: RetirementOutcome['unlockSpace'] = 'kept'
  try {
    unlockSpace = await deleteUnlockSpaceOf({ session: authority.session, method })
  } catch (err) {
    console.warn("The removed method's unlock Space could not be deleted:", err)
  }
  // 6. The registry entry, and this browser's record under the method
  await updateRegistry(authority.session, (existing) => removeMethod({ record: existing ?? emptyRegistry(), unlockSpaceId: method.unlockSpaceId }))
  await deleteClientKeyRecord(method.unlockSpaceId).catch(() => undefined)
  const partial = result.collections.failed.length > 0 || result.rosterSeal?.outcome === 'failed'
  return { session: authority.session, completion: partial ? 'partial' : 'complete', unlockSpace, annex }
}
