import { PwsClient } from '@interop/pws-client'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { UserKey } from '@interop/wallet-core/keys'
import { emptyRegistry, readUnlockMethods, updateUnlockMethods, type UnlockMethodsRecord } from './unlockMethods'
import { sessionAgents, type Session } from './session'
import { serviceDescriptionFor } from './service'

// The account's unlock-methods registry as the session reads and rewrites it
// (unlockMethods.ts is the record's codec; this is the session's access to
// it). The registry is encrypted to the user key and signed by it, so a
// rotation of the user key (a wallet disconnected, a sign-in method removed)
// re-seals it under the new key, and a sign-in that finds it sealed under an
// earlier key (a rotation interrupted before its re-seal) repairs it.

async function registryClient(session: Session): Promise<{ pws: PwsClient; capability?: IZcap }> {
  const { signer, capabilityFor } = await sessionAgents(session)
  const pws = PwsClient.fromSigner({ baseServerUrl: session.serverUrl, signer, serviceDescription: await serviceDescriptionFor(session.serverUrl) })
  const capability = capabilityFor(session.spaceId)
  return { pws, ...(capability && { capability }) }
}

export async function readRegistry(session: Session): Promise<UnlockMethodsRecord | null> {
  const { pws, capability } = await registryClient(session)
  return (await readUnlockMethods({ pws, spaceId: session.spaceId, userKey: session.userKey, ...(capability && { capability }) }))?.record ?? null
}

// Rewrites the registry under compare-and-swap.
export async function updateRegistry(session: Session, mutate: (existing: UnlockMethodsRecord | null) => UnlockMethodsRecord): Promise<UnlockMethodsRecord> {
  const { pws, capability } = await registryClient(session)
  return updateUnlockMethods({ pws, spaceId: session.spaceId, userKey: session.userKey, ...(capability && { capability }), mutate })
}

// Re-seals the registry under a new user key: read under the key the
// session holds, written under the next one. Run while both keys are at
// hand, before the session adopts the new key.
export async function resealRegistry({ session, userKey }: { session: Session; userKey: UserKey }): Promise<void> {
  const { pws, capability } = await registryClient(session)
  await updateUnlockMethods({
    pws,
    spaceId: session.spaceId,
    userKey: session.userKey,
    writeUserKey: userKey,
    ...(capability && { capability }),
    mutate: (existing) => existing ?? emptyRegistry(),
  })
}

// Opens the registry with the session's user key. One sealed under an
// earlier generation of the key (the re-seal of a rotation was interrupted)
// is opened with that generation, newest first, and re-sealed under the
// current key. Throws when no generation opens it.
export async function healRegistry({ session, generations }: { session: Session; generations: UserKey[] }): Promise<void> {
  const { pws, capability } = await registryClient(session)
  const base = { pws, spaceId: session.spaceId, ...(capability && { capability }) }
  try {
    await readUnlockMethods({ ...base, userKey: session.userKey })
    return
  } catch (err) {
    for (const generation of [...generations].reverse()) {
      if (generation.id === session.userKey.id) {
        continue
      }
      try {
        await readUnlockMethods({ ...base, userKey: generation })
      } catch {
        continue
      }
      await updateUnlockMethods({ ...base, userKey: generation, writeUserKey: session.userKey, mutate: (existing) => existing ?? emptyRegistry() })
      return
    }
    throw err
  }
}
