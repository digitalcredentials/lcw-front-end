import { test, expect } from '@playwright/test';
// The HTTP client first: its CJS/ESM mix must load before jsonld (the scripts do the same)
import '@interop/http-client';
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key';
import { createEdvDocCipher, createEdvEncryption, initRecipients, ownerRecipient, mintEpoch, epochKeyIdFor } from '@interop/pws-client/edv';
import { packTar, readTar } from '../src/lib/tar';
import { exportedCollections, packDataExport } from '../src/lib/dataExport';
import { NotAnExportError, importCredentials, readDataExport, type ImportableCredential } from '../src/lib/dataImport';

// Node-side unit assertions over the data import's pure parts: the tar
// reader, the reading of a download (its manifest and credential folders,
// tags included) and the adding against a store, plus the export's side of
// the tags (read from the archive's metadata sidecars into the manifest).
// The dialog itself runs against the deployed wallet (tests/deployed.spec.ts).

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (value: unknown) => utf8.encode(JSON.stringify(value));

const BADGE = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'OpenBadgeCredential'], name: 'Badge one', credentialSubject: { achievement: { name: 'Badge one' } } };
const OTHER = { ...BADGE, name: 'Badge two', credentialSubject: { achievement: { name: 'Badge two' } } };

test('readTar reads back what packTar wrote, and refuses other bytes', () => {
  const long = `${'a'.repeat(90)}/${'b'.repeat(90)}/c.json`;
  const tar = packTar([
    { name: 'manifest.json', bytes: utf8.encode('{}') },
    { name: 'Main Space/Badges/one.json', bytes: utf8.encode('{"v":1}') },
    { name: long, bytes: new Uint8Array(700).fill(7) },
  ]);
  const files = readTar(tar);
  // Directories are skipped; files come back whole, long names included
  expect(files.map((f) => f.name)).toEqual(['manifest.json', 'Main Space/Badges/one.json', long]);
  expect(text(files[1].bytes)).toBe('{"v":1}');
  expect(files[2].bytes.length).toBe(700);
  expect(files[2].bytes[699]).toBe(7);
  expect(() => readTar(utf8.encode('this is not a tar archive, just text that is long enough to fill a header block and then some more text to pass five hundred and twelve bytes.'.repeat(5)))).toThrow(/Not a tar/);
  expect(readTar(new Uint8Array(1024))).toEqual([]);
  // A file cut short is refused rather than read as a shorter one: the
  // archive ends with the 700-byte file (padded to 1024) and two end blocks
  expect(() => readTar(tar.subarray(0, tar.length - 1024 - 1024 + 100))).toThrow(/cut short/);
});

test('readDataExport finds the credentials of a download with their tags, skipping what is not one', () => {
  const { bytes } = packDataExport({
    account: 'someone@example.org',
    exportedAt: new Date('2026-11-13T12:00:00Z'),
    spaces: [
      {
        id: 'dcc-pws-1',
        url: 'https://was.example/space/dcc-pws-1',
        name: 'Wallet Space',
        types: ['Space'],
        collections: [
          {
            id: 'private-credentials',
            encrypted: true,
            documents: [
              { id: 'z6one', bytes: json(BADGE), extension: 'json', tags: ['Badges', 'University'] },
              // A presentation stored as a document is unwrapped
              { id: 'z6two', bytes: json({ type: ['VerifiablePresentation'], verifiableCredential: [OTHER] }), extension: 'json' },
              { id: 'z6note', bytes: json({ note: 'not a credential' }), extension: 'json' },
              { id: 'z6pic', bytes: new Uint8Array([1, 2, 3]), extension: 'png' },
            ],
          },
          { id: 'Trash', encrypted: true, documents: [{ id: 't1', bytes: json({ cid: 'x', tags: [], body: BADGE }), extension: 'json' }] },
          { id: 'wallet-activity', encrypted: true, documents: [{ id: 'a1', bytes: json({ type: ['Create'] }), extension: 'json' }] },
        ],
      },
      { id: 'dcc-pws-2', url: 'https://was.example/space/dcc-pws-2', name: 'Batch', types: ['Space', 'BatchSpace'], collections: [{ id: 'batch', encrypted: false, documents: [{ id: 'batch', bytes: json({}), extension: 'json' }] }] },
    ],
  });
  const contents = readDataExport(bytes);
  expect(contents.manifest.format).toBe('lcw-data-export/1');
  expect(contents.manifest.account).toBe('someone@example.org');
  expect(contents.manifest.spaces[0].collections[0].tags).toEqual({ 'z6one.json': ['Badges', 'University'] });
  expect(contents.credentials.map((c) => [c.file, (c.body as { name: string }).name, c.tags])).toEqual([
    ['Wallet Space/private-credentials/z6one.json', 'Badge one', ['Badges', 'University']],
    ['Wallet Space/private-credentials/z6two.json', 'Badge two', []],
  ]);
  expect(contents.skipped).toEqual([
    { file: 'Wallet Space/private-credentials/z6note.json', reason: 'not a credential' },
    { file: 'Wallet Space/private-credentials/z6pic.png', reason: 'not a JSON document' },
  ]);
});

test('readDataExport refuses what is not a download of this wallet', () => {
  expect(() => readDataExport(utf8.encode('x'.repeat(2048)))).toThrow(NotAnExportError);
  expect(() => readDataExport(packTar([{ name: 'a/b.json', bytes: json({}) }]))).toThrow(/no manifest\.json/);
  expect(() => readDataExport(packTar([{ name: 'manifest.json', bytes: utf8.encode('{') }]))).toThrow(/could not be read/);
  expect(() => readDataExport(packTar([{ name: 'manifest.json', bytes: json({ format: 'something-else/1' }) }]))).toThrow(/not a data download/);
});

test('importCredentials adds through the store, keeps what is there with its tags merged, and reports failures', async () => {
  const stored = new Map<string, string[]>([['existing', ['Badges']]]);
  const calls: string[] = [];
  const store = {
    addCredential: async ({ body, tags }: { body: Record<string, unknown>; tags?: Iterable<string> }) => {
      const name = String(body.name);
      const cid = name === 'Badge one' ? 'existing' : `new-${name}`;
      calls.push(`add ${cid} [${[...(tags ?? [])].join(',')}]`);
      if (name === 'boom') {
        throw new Error('the server said no');
      }
      if (stored.has(cid)) {
        return { cid, rid: 'r', created: false };
      }
      stored.set(cid, [...(tags ?? [])]);
      return { cid, rid: 'r', created: true };
    },
    readTags: async (cid: string) => stored.get(cid) ?? [],
    setTags: async (cid: string, tags: Iterable<string>) => {
      calls.push(`setTags ${cid} [${[...tags].join(',')}]`);
      stored.set(cid, [...tags]);
    },
  };
  const credentials: ImportableCredential[] = [
    { file: 'a/one.json', body: BADGE, tags: ['Badges', 'University'] },
    { file: 'a/two.json', body: OTHER, tags: ['Imported'] },
    { file: 'a/three.json', body: { ...BADGE, name: 'boom' }, tags: [] },
  ];
  const progress: number[] = [];
  const result = await importCredentials({ credentials, store, onProgress: (n) => progress.push(n) });
  expect(result).toEqual({ added: 1, existing: 1, failed: [{ file: 'a/three.json', reason: 'the server said no' }] });
  expect(progress).toEqual([1, 2, 3]);
  // The existing credential's tags gained the file's; its stored ones stayed
  expect(stored.get('existing')).toEqual(['Badges', 'University']);
  expect(calls).toEqual(['add existing [Badges,University]', 'setTags existing [Badges,University]', 'add new-Badge two [Imported]', 'add new-boom []']);
});

// The user key, built as wallet-core's `userKeyVaultKeys` builds it
async function userKeys() {
  const { epochId, secret } = await mintEpoch();
  const keyAgreementKey = X25519KeyAgreementKey2020.fromRawSecret({ secret, controller: epochId, id: epochKeyIdFor(epochId) });
  const keyResolver = async ({ id }: { id?: string }) => {
    if (id !== keyAgreementKey.id) {
      throw new Error(`Unknown key id "${id}".`);
    }
    return { id: keyAgreementKey.id, type: keyAgreementKey.type, publicKeyMultibase: keyAgreementKey.publicKeyMultibase };
  };
  return { keyAgreementKey, keyResolver };
}

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

// The export reads a credential's tags from the metadata sidecar the archive
// carries beside it: an envelope the collection's codec decodes on an
// encrypted collection, a plain object on a plaintext one.
test('the export carries the tags of the archived documents into the manifest', async () => {
  const keys = await userKeys();
  const encryption = await descriptorFor(keys);
  const spaceUrl = 'https://was.example/space/dcc-pws-1';
  const cipher = await createEdvDocCipher({ ...keys, collectionId: 'private-credentials', encryption });
  const sealed = await cipher.encrypt({ data: BADGE });
  const untagged = await cipher.encrypt({ data: OTHER });
  const codec = await createEdvEncryption({ resolveKeys: async () => keys, idDerivation: 'content' }).codecFor({ spaceUrl, collectionId: 'private-credentials', scheme: 'edv', encryption });
  const { custom } = await codec!.encodeMeta({ custom: { tags: { Badges: '', University: '' } }, slot: { kind: 'resource', id: sealed.id } });
  const resource = (id: string, value: unknown) => ({ id, bytes: json(value), contentType: 'application/json', extension: 'json' });
  const problems: string[] = [];
  const collections = await exportedCollections({
    space: {
      id: 'dcc-pws-1',
      meta: null,
      collections: new Map([
        [
          'private-credentials',
          {
            id: 'private-credentials',
            meta: { id: 'private-credentials', encryption },
            resources: new Map([
              [sealed.id, resource(sealed.id, sealed.envelope)],
              [untagged.id, resource(untagged.id, untagged.envelope)],
            ]),
            chunks: new Map(),
            customs: new Map([[sealed.id, custom]]),
          },
        ],
        ['notes', { id: 'notes', meta: null, resources: new Map([['n1', resource('n1', { n: 1 })]]), chunks: new Map(), customs: new Map([['n1', { tags: { Plain: '' } }]]) }],
      ]),
    },
    keys,
    spaceUrl,
    label: 'Wallet Space',
    problems,
  });
  expect(problems).toEqual([]);
  const credentials = collections.find((c) => c.id === 'private-credentials')!;
  expect(credentials.documents.find((d) => d.id === sealed.id)?.tags).toEqual(['Badges', 'University']);
  expect(credentials.documents.find((d) => d.id === untagged.id)?.tags).toBeUndefined();
  expect(collections.find((c) => c.id === 'notes')!.documents[0].tags).toEqual(['Plain']);

  // Packed, the manifest lists them by file, and the import reads them back
  const { bytes, manifest } = packDataExport({ spaces: [{ id: 'dcc-pws-1', url: spaceUrl, name: 'Wallet Space', types: ['Space'], collections }] });
  expect(manifest.spaces[0].collections.find((c) => c.id === 'private-credentials')!.tags).toEqual({ [`${sealed.id}.json`]: ['Badges', 'University'] });
  const back = readDataExport(bytes);
  expect(back.credentials.map((c) => [(c.body as { name: string }).name, c.tags]).sort()).toEqual([
    ['Badge one', ['Badges', 'University']],
    ['Badge two', []],
  ]);
});
