import { test, expect } from '@playwright/test';
import type { Collection } from '@interop/was-client';
import {
  createPublicCopy,
  findPublicCopy,
  publicCopyId,
  removePublicCopy,
} from '../src/lib/publicCopy';

// Node-side unit assertions over the public copy, against an in-memory
// stand-in for the public collection. The e2e suite covers the same behaviour
// against the local stack (tests/e2e.spec.ts).

// The parts of a Collection the helpers use: put, and a resource handle with
// isPublic / setPublic / clearPolicy / delete. A resource maps to whether it
// is public.
function fakeCollection(
  initial: Record<string, boolean> = {},
  { failSetPublic = false, failIsPublic = false }: { failSetPublic?: boolean; failIsPublic?: boolean } = {}
) {
  const resources = new Map(Object.entries(initial));
  const collection = {
    async put(id: string) {
      resources.set(id, resources.get(id) ?? false);
    },
    resource(id: string) {
      return {
        async isPublic() {
          if (failIsPublic) {
            throw new Error('policy read failed');
          }
          return resources.get(id) === true;
        },
        async setPublic() {
          if (failSetPublic) {
            throw new Error('setPublic failed');
          }
          resources.set(id, true);
        },
        async clearPolicy() {
          if (resources.has(id)) {
            resources.set(id, false);
          }
        },
        async delete() {
          resources.delete(id);
        },
      };
    },
  };
  return { pub: collection as unknown as Collection, resources };
}

test('the copy is named for the collection and the credential', () => {
  expect(publicCopyId('Employment', 'z1A2j')).toBe('Employment--z1A2j');
});

test('finds nothing when the credential is not shared', async () => {
  const { pub } = fakeCollection({ 'Skills--other': true });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
});

test('finds the public copy', async () => {
  const { pub } = fakeCollection({ 'Employment--z1A2j': true });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBe('Employment--z1A2j');
});

test('a copy that is not public does not count', async () => {
  const { pub } = fakeCollection({ 'Employment--z1A2j': false });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
});

test('a policy that cannot be read is an error, not "not shared"', async () => {
  const { pub } = fakeCollection({ 'Employment--z1A2j': true }, { failIsPublic: true });
  await expect(findPublicCopy(pub, 'Employment', 'z1A2j')).rejects.toThrow('policy read failed');
});

test('taking the link down and sharing again brings the same link back', async () => {
  const { pub, resources } = fakeCollection();
  const first = await createPublicCopy(pub, 'Employment', 'z1A2j', {});
  await removePublicCopy(pub, 'Employment', 'z1A2j');
  expect(resources.size).toBe(0);
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
  const second = await createPublicCopy(pub, 'Employment', 'z1A2j', {});
  expect(second).toBe(first);
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBe(first);
});

test('taking it down leaves other credentials shared', async () => {
  const { pub, resources } = fakeCollection({ 'Employment--z1A2j': true, 'Employment--z1A2j--other': true });
  await removePublicCopy(pub, 'Employment', 'z1A2j');
  expect([...resources.keys()]).toEqual(['Employment--z1A2j--other']);
});

test('a share that cannot be made public fails, and does not count as shared', async () => {
  const { pub } = fakeCollection({}, { failSetPublic: true });
  await expect(createPublicCopy(pub, 'Employment', 'z1A2j', {})).rejects.toThrow('setPublic failed');
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
});

test('a failed share does not delete a copy that was already live', async () => {
  const { pub, resources } = fakeCollection({ 'Employment--z1A2j': true }, { failSetPublic: true });
  await expect(createPublicCopy(pub, 'Employment', 'z1A2j', {})).rejects.toThrow('setPublic failed');
  expect(resources.get('Employment--z1A2j')).toBe(true);
});
