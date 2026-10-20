import { test, expect } from '@playwright/test';
import type { Collection } from '@interop/was-client';
import {
  createPublicCopy,
  findPublicCopy,
  isPublicCopyOf,
  newPublicCopyId,
  removePublicCopies,
} from '../src/lib/publicCopy';

// Node-side unit assertions over the public-copy id scheme, against an
// in-memory stand-in for the public collection. The e2e suite covers the same
// behaviour against the local stack (tests/e2e.spec.ts).

const UUID = '0b5e2c7a-3f41-4d8e-9c2b-6a1f0e9d8c7b';

// The parts of a Collection the helpers use: list, put, and a resource handle
// with isPublic / setPublic / clearPolicy / delete.
function fakeCollection(initial: Record<string, boolean> = {}, { failSetPublic = false } = {}) {
  const resources = new Map(Object.entries(initial));
  const collection = {
    async list() {
      return resources.size ? { items: [...resources.keys()].map((id) => ({ id })) } : null;
    },
    async put(id: string) {
      resources.set(id, false);
    },
    resource(id: string) {
      return {
        async isPublic() {
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

test('a new id keeps the origin prefix and ends in a uuid', () => {
  const id = newPublicCopyId('Employment', 'z1A2j');
  expect(id).toMatch(/^Employment--z1A2j--[0-9a-f-]{36}$/);
  expect(isPublicCopyOf(id, 'Employment', 'z1A2j')).toBe(true);
});

test('each new id is different', () => {
  expect(newPublicCopyId('Employment', 'z1A2j')).not.toBe(newPublicCopyId('Employment', 'z1A2j'));
});

test('the old fixed id still counts as a copy', () => {
  expect(isPublicCopyOf('Employment--z1A2j', 'Employment', 'z1A2j')).toBe(true);
});

test('a sibling credential whose id extends this one does not count', () => {
  expect(isPublicCopyOf('Employment--z1A2j--other', 'Employment', 'z1A2j')).toBe(false);
  expect(isPublicCopyOf(`Employment--z1A2j--other--${UUID}`, 'Employment', 'z1A2j')).toBe(false);
  expect(isPublicCopyOf('Employment--z1A2', 'Employment', 'z1A2j')).toBe(false);
  expect(isPublicCopyOf(`Skills--z1A2j--${UUID}`, 'Employment', 'z1A2j')).toBe(false);
});

test('finds nothing in a space that has never shared', async () => {
  const { pub } = fakeCollection();
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
});

test('finds an old-style copy', async () => {
  const { pub } = fakeCollection({ 'Employment--z1A2j': true, 'Skills--other': true });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBe('Employment--z1A2j');
});

test('ignores a copy that is not public', async () => {
  const { pub } = fakeCollection({ [`Employment--z1A2j--${UUID}`]: false });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBeNull();
});

test('prefers a new-style copy over an old one', async () => {
  const { pub } = fakeCollection({ 'Employment--z1A2j': true, [`Employment--z1A2j--${UUID}`]: true });
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBe(`Employment--z1A2j--${UUID}`);
});

test('sharing again after taking the link down gives a different id', async () => {
  const { pub, resources } = fakeCollection({ 'Employment--z1A2j': true });
  await removePublicCopies(pub, 'Employment', 'z1A2j');
  expect(resources.size).toBe(0);
  const first = await createPublicCopy(pub, 'Employment', 'z1A2j', {});
  await removePublicCopies(pub, 'Employment', 'z1A2j');
  const second = await createPublicCopy(pub, 'Employment', 'z1A2j', {});
  expect(second).not.toBe(first);
  expect(second).not.toBe('Employment--z1A2j');
  expect(await findPublicCopy(pub, 'Employment', 'z1A2j')).toBe(second);
  expect([...resources.keys()]).toEqual([second]);
});

test('taking it down removes every copy of this credential and nothing else', async () => {
  const { pub, resources } = fakeCollection({
    'Employment--z1A2j': true,
    [`Employment--z1A2j--${UUID}`]: true,
    'Employment--z1A2j--other': true,
  });
  await removePublicCopies(pub, 'Employment', 'z1A2j');
  expect([...resources.keys()]).toEqual(['Employment--z1A2j--other']);
});

test('a copy that cannot be made public is deleted again', async () => {
  const { pub, resources } = fakeCollection({}, { failSetPublic: true });
  await expect(createPublicCopy(pub, 'Employment', 'z1A2j', {})).rejects.toThrow('setPublic failed');
  expect(resources.size).toBe(0);
});
