import { PwsClient, type ResourceData } from '@interop/pws-client'
import { runClientAnnexGc, type ClientAnnexGcReport } from '@interop/wallet-core/clientAnnex'
import { WALLET_ACTIVITY_COLLECTION, addHistoryGenerationCollected } from '@interop/wallet-core/space'
import { ceremonyAuthority } from './authority'
import type { RememberedSession } from './session'

// Collects the client-annex generations nothing points at any more. Every
// password visit appends an entry to the pointed generation's log, each
// carrying the generation's whole document; a visit that finds the log at
// 24 entries mints a fresh generation and points the account at it
// (transient.ts), and the generations left behind would otherwise stay in
// the annex Space for good. wallet-core's GC pass lists the annex Space's
// `gen-` collections and deletes the ones the pointer does not name,
// recording a GenerationCollect entry in wallet-activity for each: the
// pass FreeWallet runs at its remembered logins. Only an enrolled client (a
// remembered session) can run it, since the deletes are root writes on the
// annex Space.
//
// The pass's other arm, a quarterly swap of the pointed generation, needs
// the login credential's ladder seed and the account's replica servers.
// This wallet renews the pointed generation at transient visits instead
// and hands the pass no seed, so the swap reports no-ladder-seed and only
// the collection runs. Best effort: a failure is logged and never fails
// the login.

let pending: Promise<ClientAnnexGcReport | null> | null = null

export async function collectClientAnnexGenerations(session: RememberedSession): Promise<ClientAnnexGcReport | null> {
  try {
    const authority = await ceremonyAuthority(session)
    const verified = await authority.verified()
    const pws = new PwsClient({ baseServerUrl: session.serverUrl, zcapClient: authority.zcapClient, serviceDescription: authority.serviceDescription })
    const space = await authority.spaceHandle()
    const report = await runClientAnnexGc({
      pws,
      baseServerUrl: session.serverUrl,
      accountSpaceId: session.spaceId,
      account: { did: session.did, doc: verified.doc, log: verified.log },
      idStore: authority.idStore,
      updateKeys: session.webvhUpdateKeys,
      zcapClient: authority.zcapClient,
      // Without a ladder seed no swap runs, so the servers a swap would
      // restate are not consulted
      replicaServerDids: [],
      recordDigest: async (digest) => {
        await space.collection(WALLET_ACTIVITY_COLLECTION).add(addHistoryGenerationCollected({ user: { email: session.email }, ...digest }) as unknown as ResourceData)
      },
    })
    if (report.collected.length || report.failed.length || report.deferred.length) {
      console.info(`Wallet: client-annex generations collected ${report.collected.length}, deferred ${report.deferred.length}, failed ${report.failed.length}.`)
    }
    return report
  } catch (err) {
    console.warn('Wallet: the client-annex generations could not be collected:', err)
    return null
  }
}

// Runs the collection after a remembered login without holding the login
// up; `pendingAnnexCollection` lets a script wait for it.
export function collectClientAnnexGenerationsInBackground(session: RememberedSession): void {
  pending = collectClientAnnexGenerations(session).finally(() => {
    pending = null
  })
}

export const pendingAnnexCollection = (): Promise<ClientAnnexGcReport | null> => pending ?? Promise.resolve(null)
