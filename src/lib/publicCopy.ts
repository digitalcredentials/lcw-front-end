// Sharing a credential publishes a plaintext copy of it in the space's
// `public` collection and makes that copy world-readable; taking the link
// down deletes the copy. The copy's id is fixed for the credential:
//
//   {collection}--{credential}
//
// so taking a link down and sharing again brings the same link back, and a
// LinkedIn entry, an email or a job application that carries it works again.
// Decided with James and Kerri on 21 October 2026 (#153); the mobile wallet
// gave each share a new link only because of how VerifierPlus created links.
import type { Collection } from '@interop/was-client';

export function publicCopyId(collectionId: string, credentialId: string): string {
  return `${collectionId}--${credentialId}`;
}

// The id of the credential's public copy, or null when it is not shared. A
// copy without a public policy is not a working link, so it does not count.
// Throws when it cannot tell, rather than reporting a live link as "not
// shared".
export async function findPublicCopy(
  pub: Collection, collectionId: string, credentialId: string
): Promise<string | null> {
  const id = publicCopyId(collectionId, credentialId);
  return (await pub.resource(id).isPublic()) ? id : null;
}

// Publishes the credential's body as its public copy and makes it
// world-readable. Resolves to the copy's id. A failure is not rolled back:
// with one fixed id, deleting could take down a copy that was already live
// (shared from another tab), and a copy that is not public is no link at all.
export async function createPublicCopy(
  pub: Collection, collectionId: string, credentialId: string, body: Parameters<Collection['put']>[1]
): Promise<string> {
  const id = publicCopyId(collectionId, credentialId);
  await pub.put(id, body);
  await pub.resource(id).setPublic();
  return id;
}

// Takes the public copy down: its policy first, so the link stops working even
// if the delete then fails, then the copy itself.
export async function removePublicCopy(
  pub: Collection, collectionId: string, credentialId: string
): Promise<void> {
  const id = publicCopyId(collectionId, credentialId);
  await pub.resource(id).clearPolicy();
  await pub.resource(id).delete().catch(() => undefined);
}
