import { UNLOCK_METHODS_COLLECTION, plaintextCollection } from '@interop/wallet-core/space'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { unlockSpaceUrl } from './records'
import { readRegistry, registryClient } from './registry'
import type { Session } from './session'
import { deleteManagedUnlockSpace } from './unlockSpaceDeletion'

// Notes of unlock Spaces that are being created for a recovery code.
//
// A recovery code is issued without the user taking part (the sign-in page
// does it in the background), and until the back end holds the code it
// exists only in the page's memory. An issuance interrupted (the tab closed,
// the page left) after the code's unlock Space was created and before the
// account listed the code would leave a Space whose only key is lost:
// nothing could delete it, and it would count toward the account's limit
// permanently (the PWS server limits how many Spaces one account has).
//
// So the issuance writes a note in the account Space before it creates the
// Space: the Space's id and the capability to manage it, which the code's
// own key delegates to the account (a signature, so it can be made before
// the Space exists). The note is removed once the account's registry lists
// the code. A note found later whose Space the registry does not list is an
// issuance that never finished: its Space is deleted through the capability,
// then the note. A code that was never listed was never handed to the back
// end either, so nobody holds it and nothing is lost by deleting its Space.
//
// The notes are plain JSON in the registry's collection (`unlock-methods/`).
// They tell the server nothing it does not already record: it knows which
// account each Space was created under.

export interface PendingSpaceNote {
  version: 1
  unlockSpaceId: string
  // Delegated by the unlock Space's own key to the account
  manageCapability: IZcap
  createdAt: string
}

// What a clean-up did, as unlock Space ids
export interface PendingCleanUp {
  // The registry lists the method: the issuance finished, the note is removed
  listed: string[]
  // Younger than the waiting period: an issuance may be running, so nothing
  // is done
  waiting: string[]
  // Never listed: the Space is deleted and the note removed
  deleted: string[]
  // Never listed, and the server answered 404 to the deletion (the Space was
  // never created, or is already gone): the note is removed
  notFound: string[]
  // Never listed, and the capability has expired: the note is removed, since
  // it can delete nothing any more
  expired: string[]
  // An error occurred: the note is kept for the next clean-up
  failed: string[]
}

// How long a note is not acted on: longer than any issuance takes, so a
// clean-up in one tab never deletes the Space of an issuance running in
// another.
export const PENDING_SPACE_WAIT_MS = 10 * 60 * 1000

const NOTE_PREFIX = 'pending-'
const NOTE_SUFFIX = '.json'
const noteId = (unlockSpaceId: string) => `${NOTE_PREFIX}${unlockSpaceId}${NOTE_SUFFIX}`
const isNoteId = (id: string) => id.startsWith(NOTE_PREFIX) && id.endsWith(NOTE_SUFFIX)

async function notes(session: Session) {
  const { pws, capability } = await registryClient(session)
  return plaintextCollection({ pws, spaceId: session.spaceId, collectionId: UNLOCK_METHODS_COLLECTION.id, ...(capability && { capability }) })
}

function parseNote(value: unknown): PendingSpaceNote | null {
  const note = value as Partial<PendingSpaceNote> | null
  if (
    !note ||
    typeof note !== 'object' ||
    note.version !== 1 ||
    typeof note.unlockSpaceId !== 'string' ||
    typeof note.createdAt !== 'string' ||
    Number.isNaN(Date.parse(note.createdAt)) ||
    !note.manageCapability ||
    typeof note.manageCapability !== 'object'
  ) {
    return null
  }
  return note as PendingSpaceNote
}

// Writes the note for an unlock Space about to be created.
export async function notePendingSpace({ session, unlockSpaceId, manageCapability }: { session: Session; unlockSpaceId: string; manageCapability: IZcap }): Promise<void> {
  const note: PendingSpaceNote = { version: 1, unlockSpaceId, manageCapability, createdAt: new Date().toISOString() }
  const collection = await notes(session)
  await collection.resource(noteId(unlockSpaceId)).put(new TextEncoder().encode(JSON.stringify(note)), { contentType: 'application/json' })
}

// Removes the note of an unlock Space the registry now lists.
export async function clearPendingSpace({ session, unlockSpaceId }: { session: Session; unlockSpaceId: string }): Promise<void> {
  const collection = await notes(session)
  await collection.resource(noteId(unlockSpaceId)).delete()
}

// Handles every note in the account: removes the ones whose method the
// registry lists, and deletes the Space of each one that was never listed
// and is older than the waiting period. One request when there is no note,
// which is the usual case.
export async function cleanUpPendingSpaces({ session, now = Date.now(), waitMs = PENDING_SPACE_WAIT_MS }: { session: Session; now?: number; waitMs?: number }): Promise<PendingCleanUp> {
  const done: PendingCleanUp = { listed: [], waiting: [], deleted: [], notFound: [], expired: [], failed: [] }
  const collection = await notes(session)
  const ids: string[] = []
  for await (const item of collection.listItems()) {
    if (isNoteId(item.id)) {
      ids.push(item.id)
    }
  }
  if (ids.length === 0) {
    return done
  }
  const registry = await readRegistry(session)
  if (!registry) {
    // Without the registry a finished issuance cannot be told from an
    // unfinished one, so nothing is deleted
    return done
  }
  const listed = new Set(registry.methods.map((method) => method.unlockSpaceId))
  for (const id of ids) {
    const resource = collection.resource(id)
    const note = parseNote(await resource.get().catch(() => null))
    // Removed since the listing, or not a note this version wrote: not touched
    if (!note || noteId(note.unlockSpaceId) !== id) {
      continue
    }
    const { unlockSpaceId, manageCapability } = note
    try {
      if (listed.has(unlockSpaceId)) {
        await resource.delete()
        done.listed.push(unlockSpaceId)
        continue
      }
      if (now - Date.parse(note.createdAt) < waitMs) {
        done.waiting.push(unlockSpaceId)
        continue
      }
      // The capability must be the one for the Space the note names, and
      // that Space is never the account's own or the one this session opened
      if (unlockSpaceId === session.spaceId || unlockSpaceId === session.unlockSpaceId || manageCapability.invocationTarget !== unlockSpaceUrl(session.serverUrl, unlockSpaceId)) {
        done.failed.push(unlockSpaceId)
        continue
      }
      const outcome = await deleteManagedUnlockSpace({ session, unlockSpaceId, manageCapability })
      await resource.delete()
      ;(outcome === 'deleted' ? done.deleted : done.notFound).push(unlockSpaceId)
    } catch (err) {
      if ((err as { name?: string }).name === 'ExpiredParentCapabilityError') {
        await resource.delete().catch(() => undefined)
        done.expired.push(unlockSpaceId)
        continue
      }
      console.warn(`The Space of an unfinished recovery code (${unlockSpaceId}) could not be cleaned up:`, err)
      done.failed.push(unlockSpaceId)
    }
  }
  return done
}
