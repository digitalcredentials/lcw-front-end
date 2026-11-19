import { ladderVmAgent, ladderVmZcapClient, mintSpaceVerbCapability } from '@interop/wallet-core/clientAnnex'
import { deleteUnlockSpace } from '@interop/wallet-core/keyring'
import { didKeyZcapClient } from '@interop/wallet-core/webvh'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { sessionAgents, type Session } from './session'
import { serviceDescriptionFor } from './service'

// Deletes a sign-in method's unlock Space through a DELETE-only child of its
// management capability (the capability the method's own key delegated to
// the account when the Space was made): a password session delegates and
// invokes the child as its ladder VM (the server admits a ladder-signed link
// that is exactly a target-exact DELETE of the parent's own Space), a
// passkey session as the account. The server answers 404 both for a Space
// that is not there and for a capability it refuses, so `not-found` is
// either of the two.
export async function deleteManagedUnlockSpace({
  session,
  unlockSpaceId,
  manageCapability,
}: {
  session: Session
  unlockSpaceId: string
  manageCapability: IZcap
}): Promise<'deleted' | 'not-found'> {
  const base = { baseServerUrl: session.serverUrl, serviceDescription: await serviceDescriptionFor(session.serverUrl), spaceId: unlockSpaceId }
  if (session.kind === 'transient') {
    const ladderAgent = await ladderVmAgent({ ladderSeed: session.ladderSeed })
    const child = await mintSpaceVerbCapability({
      zcapClient: await ladderVmZcapClient({ accountDid: session.did, ladderSeed: session.ladderSeed }),
      parent: manageCapability,
      verb: 'DELETE',
      controller: ladderAgent.id.split('#')[0],
    })
    return (await deleteUnlockSpace({ ...base, zcapClient: didKeyZcapClient({ keyAgent: ladderAgent }), capability: child })).outcome
  }
  const { zcapClient } = await sessionAgents(session)
  const child = await mintSpaceVerbCapability({ zcapClient, parent: manageCapability, verb: 'DELETE', controller: session.did })
  return (await deleteUnlockSpace({ ...base, zcapClient, capability: child })).outcome
}
