import { test, expect } from '@playwright/test';
// The HTTP client first: its CJS/ESM mix must load before jsonld (the scripts do the same)
import '@interop/http-client';
import { packSpaceArchive, collectBytes, fileNameFor, collectionMetadataFileName, spaceMetadataFileName } from '@interop/space-archive';
import { packTar } from '../src/lib/tar';
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key';
import { createEdvDocCipher, initRecipients, ownerRecipient, mintEpoch, epochKeyIdFor } from '@interop/pws-client/edv';
import { readArchivedSpace, packDataExport, exportedCollections, safeName, extensionFor, EXCLUDED_COLLECTIONS } from '../src/lib/dataExport';

// Node-side unit assertions over the data export's pure parts: the tar
// writer, the reading of a Space archive (what the PWS server's Export Space
// operation answers) and the packing of the plain documents. Decryption and
// the download itself run against the deployed wallet (tests/deployed.spec.ts).

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// A minimal ustar reader for the assertions: name, type and bytes per entry.
function readTar(bytes: Uint8Array): { name: string; type: string; bytes: Uint8Array }[] {
  const entries: { name: string; type: string; bytes: Uint8Array }[] = [];
  const field = (block: Uint8Array, offset: number, length: number) =>
    text(block.subarray(offset, offset + length)).replace(/\0.*$/s, '');
  let at = 0;
  while (at + 512 <= bytes.length) {
    const block = bytes.subarray(at, at + 512);
    if (block.every((b) => b === 0)) {
      break;
    }
    const expected = parseInt(field(block, 148, 8).trim(), 8);
    let sum = 0;
    block.forEach((b, i) => {
      sum += i >= 148 && i < 156 ? 0x20 : b;
    });
    if (sum !== expected) {
      throw new Error(`bad checksum at ${at}`);
    }
    const prefix = field(block, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(block, 0, 100);
    const size = parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = field(block, 156, 1) || '0';
    entries.push({ name, type, bytes: bytes.slice(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('packTar writes a ustar archive with the implied directories', () => {
  const long = `${'a'.repeat(90)}/${'b'.repeat(90)}/c.json`;
  const tar = packTar(
    [
      { name: 'manifest.json', bytes: utf8.encode('{}') },
      { name: 'Main Space/Badges/one.json', bytes: utf8.encode('{"v":1}') },
      { name: long, bytes: new Uint8Array(700) },
    ],
    { mtime: 1_700_000_000 }
  );
  expect(tar.length % 512).toBe(0);
  const entries = readTar(tar);
  expect(entries.map((e) => `${e.type} ${e.name}`)).toEqual([
    '0 manifest.json',
    '5 Main Space/',
    '5 Main Space/Badges/',
    '0 Main Space/Badges/one.json',
    `5 ${'a'.repeat(90)}/`,
    `5 ${'a'.repeat(90)}/${'b'.repeat(90)}/`,
    `0 ${long}`,
  ]);
  expect(text(entries[3].bytes)).toBe('{"v":1}');
  expect(entries[6].bytes.length).toBe(700);
});

test('safeName keeps folder names usable and extensionFor maps media types', () => {
  expect(safeName(' My/Space: "quoted"? ', 'x')).toBe('My Space quoted');
  expect(safeName('...hidden', 'x')).toBe('hidden');
  expect(safeName('   ', 'fallback')).toBe('fallback');
  expect(safeName('x'.repeat(100), 'f')).toHaveLength(80);
  expect(extensionFor('application/json')).toBe('json');
  expect(extensionFor('application/vc+ld+json')).toBe('json');
  expect(extensionFor('image/png')).toBe('png');
  expect(extensionFor('application/octet-stream', 'dat')).toBe('dat');
});

// A Space archive as the server packs one: two document collections, one
// excluded `id` collection, and a space name.
async function fixtureArchive(spaceId: string): Promise<Uint8Array> {
  const json = (value: unknown) => utf8.encode(JSON.stringify(value));
  const pack = await packSpaceArchive({
    spaceId,
    entries: [
      { name: spaceMetadataFileName(spaceId), bytes: json({ id: spaceId, type: ['Space'], name: 'Main Space' }) },
      {
        name: 'Badges',
        files: [
          { name: collectionMetadataFileName('Badges'), bytes: json({ id: 'Badges', type: ['Collection'] }) },
          { name: fileNameFor({ resourceId: 'one', contentType: 'application/json' }), bytes: json({ name: 'Badge one' }) },
          { name: fileNameFor({ resourceId: 'two', contentType: 'image/png' }), bytes: new Uint8Array([1, 2, 3]) },
        ],
      },
      {
        name: 'Secret',
        files: [
          {
            name: collectionMetadataFileName('Secret'),
            bytes: json({ id: 'Secret', type: ['Collection'], encryption: { scheme: 'edv', version: 1 } }),
          },
          { name: fileNameFor({ resourceId: 'z6sealed', contentType: 'application/json' }), bytes: json({ jwe: {} }) },
        ],
      },
      {
        name: 'id',
        files: [{ name: fileNameFor({ resourceId: 'did.jsonl', contentType: 'application/jsonl' }), bytes: utf8.encode('{}\n') }],
      },
    ],
  });
  return collectBytes(pack);
}

test('readArchivedSpace reads a Space archive, leaving the excluded collections out', async () => {
  const spaceId = 'dcc-was-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const space = await readArchivedSpace(await fixtureArchive(spaceId));
  expect(space.id).toBe(spaceId);
  expect(space.meta?.name).toBe('Main Space');
  expect([...space.collections.keys()].sort()).toEqual(['Badges', 'Secret']);
  expect(EXCLUDED_COLLECTIONS).toContain('id');
  const badges = space.collections.get('Badges')!;
  expect(badges.meta?.encryption).toBeUndefined();
  expect([...badges.resources.keys()].sort()).toEqual(['one', 'two']);
  expect(badges.resources.get('one')).toMatchObject({ contentType: 'application/json', extension: 'json' });
  expect(text(badges.resources.get('one')!.bytes)).toBe('{"name":"Badge one"}');
  expect(badges.resources.get('two')).toMatchObject({ contentType: 'image/png', extension: 'png' });
  const secret = space.collections.get('Secret')!;
  expect(secret.meta?.encryption).toMatchObject({ scheme: 'edv' });
  expect([...secret.resources.keys()]).toEqual(['z6sealed']);
});

test('packDataExport lays the documents out by space and collection, with a manifest first', () => {
  const { bytes, manifest } = packDataExport({
    account: 'someone@example.org',
    exportedAt: new Date('2026-11-09T12:00:00Z'),
    problems: ['Main Space/Secret/z6broken could not be decrypted and was left out.'],
    spaces: [
      {
        id: 'dcc-was-1',
        url: 'https://was.example/space/dcc-was-1',
        name: 'Main Space',
        types: ['Space'],
        collections: [
          { id: 'Badges', encrypted: true, documents: [{ id: 'z6one', bytes: utf8.encode('{}'), extension: 'json' }] },
          { id: 'Trash', encrypted: true, documents: [] },
        ],
      },
      {
        id: 'dcc-was-2',
        url: 'https://was.example/space/dcc-was-2',
        name: 'Main Space',
        types: ['Space', 'BatchSpace'],
        collections: [{ id: 'batches', encrypted: false, documents: [{ id: 'b/1', bytes: utf8.encode('{}'), extension: 'json' }] }],
      },
      { id: 'dcc-was-3', url: 'https://was.example/space/dcc-was-3', types: ['Space'], collections: [] },
    ],
  });
  const entries = readTar(bytes);
  expect(entries[0].name).toBe('manifest.json');
  expect(JSON.parse(text(entries[0].bytes))).toEqual(manifest);
  expect(entries.filter((e) => e.type === '0').map((e) => e.name)).toEqual([
    'manifest.json',
    'Main Space/Badges/z6one.json',
    'Main Space (2)/batches/b 1.json',
  ]);
  expect(manifest.spaces.map((s) => s.folder)).toEqual(['Main Space', 'Main Space (2)', 'dcc-was-3']);
  expect(manifest.spaces[0].collections).toEqual([
    { folder: 'Badges', id: 'Badges', encrypted: true, documents: 1 },
    { folder: 'Trash', id: 'Trash', encrypted: true, documents: 0 },
  ]);
  expect(manifest.excludedCollections).toEqual(['id', 'key-map', 'unlock-methods', 'connections', 'inbox', 'app-keys', 'account', 'dids', 'public']);
  expect(manifest.problems).toHaveLength(1);
  expect(manifest.exportedAt).toBe('2026-11-09T12:00:00.000Z');
});

// An encrypted collection as the wallet writes one: a descriptor with one key
// epoch wrapped to the user key, and envelopes sealed under it. The export
// opens them with the user key alone, from the archive, no server involved.
// The user key is built as wallet-core's `userKeyVaultKeys` builds it
// (wallet-core itself cannot load under the Playwright runner).
test('exportedCollections decrypts an encrypted collection with the user key and reports what it cannot open', async () => {
  async function userKeys() {
    const { epochId, secret } = await mintEpoch();
    const keyAgreementKey = X25519KeyAgreementKey2020.fromRawSecret({ secret, controller: epochId, id: epochKeyIdFor(epochId) });
    // pws-client's singleKeyResolver (its identity module cannot load here)
    const keyResolver = async ({ id }: { id?: string }) => {
      if (id !== keyAgreementKey.id) {
        throw new Error(`Unknown key id "${id}".`);
      }
      return { id: keyAgreementKey.id, type: keyAgreementKey.type, publicKeyMultibase: keyAgreementKey.publicKeyMultibase };
    };
    return { keyAgreementKey, keyResolver };
  }
  // An in-memory descriptor host (the collection's `encryption` member),
  // serving the ETag a recipient change is pinned to
  async function descriptorFor(keys: Awaited<ReturnType<typeof userKeys>>) {
    let stored: { descriptor: unknown; etag: string } = { descriptor: { scheme: 'edv' }, etag: '"0"' };
    const store = {
      read: async () => stored as never,
      replace: async (descriptor: unknown) => {
        stored = { descriptor, etag: '"1"' };
      },
    };
    return (await initRecipients({ store, recipients: [ownerRecipient({ keyAgreementKey: keys.keyAgreementKey })] })) as never;
  }
  const keys = await userKeys();
  const encryption = await descriptorFor(keys);
  const cipher = await createEdvDocCipher({ ...keys, collectionId: 'Badges', encryption });
  const sealed = await cipher.encrypt({ data: { type: ['VerifiableCredential'], name: 'Badge one' } });
  // A document sealed under another collection's epochs, which this reader holds no key for
  const stranger = await userKeys();
  const foreignCipher = await createEdvDocCipher({ ...stranger, collectionId: 'Badges', encryption: await descriptorFor(stranger) });
  const foreign = await foreignCipher.encrypt({ data: { secret: true } });

  const resources = new Map();
  const put = (id: string, envelope: unknown) =>
    resources.set(id, { id, bytes: utf8.encode(JSON.stringify(envelope)), contentType: 'application/json', extension: 'json' });
  put(sealed.id, sealed.envelope);
  put(foreign.id, foreign.envelope);
  const problems: string[] = [];
  const collections = await exportedCollections({
    space: {
      id: 'dcc-was-1',
      meta: null,
      collections: new Map([
        ['Badges', { id: 'Badges', meta: { id: 'Badges', encryption }, resources, chunks: new Map() }],
        ['notes', { id: 'notes', meta: null, resources: new Map([['n1', { id: 'n1', bytes: utf8.encode('{"n":1}'), contentType: 'application/json', extension: 'json' }]]), chunks: new Map() }],
      ]),
    },
    keys,
    label: 'Main Space',
    problems,
  });
  expect(collections.map((c) => `${c.id}:${c.encrypted}:${c.documents.length}`)).toEqual(['Badges:true:1', 'notes:false:1']);
  const badge = collections[0].documents[0];
  expect(badge.id).toBe(sealed.id);
  expect(badge.extension).toBe('json');
  expect(JSON.parse(text(badge.bytes))).toEqual({ type: ['VerifiableCredential'], name: 'Badge one' });
  expect(problems).toEqual([`Main Space/Badges/${foreign.id} could not be decrypted and was left out.`]);
});
