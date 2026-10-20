// Sharing a credential publishes a plaintext copy of it in the space's
// `public` collection and makes that copy world-readable; taking the link
// down deletes the copy. Each share gets a new, unguessable id, so a link
// taken down stays down when the credential is shared again (the mobile
// wallet's behaviour). The id keeps the `{collection}--{credential}` prefix
// so the copy's origin stays recognisable:
//
//   {collection}--{credential}--{uuid}
//
// Copies made before this scheme used the prefix alone as their id. They are
// still recognised as the credential's current link, and removed with it.
import type { Collection } from '@interop/was-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function legacyId(collectionId: string, credentialId: string): string {
  return `${collectionId}--${credentialId}`;
}

// A new id for a public copy of the credential.
export function newPublicCopyId(collectionId: string, credentialId: string): string {
  return `${legacyId(collectionId, credentialId)}--${crypto.randomUUID()}`;
}

// Whether a resource id in the public collection is a copy of the credential:
// the old fixed id, or the prefix followed by exactly one uuid. The strict
// suffix keeps a sibling credential whose own id extends this one's (`foo` and
// `foo--bar`) from counting as a copy of it.
export function isPublicCopyOf(id: string, collectionId: string, credentialId: string): boolean {
  const prefix = legacyId(collectionId, credentialId);
  if (id === prefix) {
    return true;
  }
  return id.startsWith(`${prefix}--`) && UUID.test(id.slice(prefix.length + 2));
}

export function isLegacyPublicCopyId(id: string, collectionId: string, credentialId: string): boolean {
  return id === legacyId(collectionId, credentialId);
}

// The ids of every copy of the credential in the public collection, public or
// not. Empty when the space has never shared anything (no public collection).
async function copyIds(pub: Collection, collectionId: string, credentialId: string): Promise<string[]> {
  const list = await pub.list();
  return (list?.items ?? [])
    .map((item) => item.id)
    .filter((id) => isPublicCopyOf(id, collectionId, credentialId));
}

// The id of the credential's current public copy, or null when it is not
// shared. A copy without a public policy is not a working link, so it does not
// count. Only one copy should be public at a time; should an earlier failure
// have left two, a new-style copy wins over an old one.
export async function findPublicCopy(
  pub: Collection, collectionId: string, credentialId: string
): Promise<string | null> {
  const ids = await copyIds(pub, collectionId, credentialId);
  const flags = await Promise.all(ids.map((id) => pub.resource(id).isPublic().catch(() => false)));
  const live = ids.filter((_, i) => flags[i]);
  return live.find((id) => !isLegacyPublicCopyId(id, collectionId, credentialId)) ?? live[0] ?? null;
}

// Publishes a new copy of the credential's body and makes it world-readable.
// Resolves to the copy's id. If the copy cannot be made public, it is deleted
// again, so a failed share leaves nothing behind.
export async function createPublicCopy(
  pub: Collection, collectionId: string, credentialId: string, body: Parameters<Collection['put']>[1]
): Promise<string> {
  const id = newPublicCopyId(collectionId, credentialId);
  await pub.put(id, body);
  try {
    await pub.resource(id).setPublic();
  } catch (err) {
    await pub.resource(id).delete().catch(() => undefined);
    throw err;
  }
  return id;
}

// Takes every copy of the credential down, old-style and new: its policy
// first, so the link stops working even if the delete then fails, then the
// copy itself.
export async function removePublicCopies(
  pub: Collection, collectionId: string, credentialId: string
): Promise<void> {
  const ids = await copyIds(pub, collectionId, credentialId);
  for (const id of ids) {
    await pub.resource(id).clearPolicy();
    await pub.resource(id).delete().catch(() => undefined);
  }
}
