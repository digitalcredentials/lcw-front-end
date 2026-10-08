// Seeds the deployed demo account's Main Space with what the deployed tests
// expect: a "UniversityOfToronto" collection (encrypted, the way the wallet
// creates collections) holding the LCW Experience Badge fixture. Idempotent:
// a collection or credential already there is left alone.
//
// The account itself must exist first (registered through the wallet with
// the demo passphrase, and its confirmation email clicked).
//
//   DEMO_EMAIL=jc.chartrand@gmail.com node tests/scripts/seed-demo.mjs
//
// Environment: DEMO_EMAIL (required), DEMO_PASSPHRASE (defaults to the
// deployed tests' passphrase), API_BASE (defaults to the sandbox back end).

import '@interop/http-client';
import { readFileSync } from 'node:fs';
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key';
import { Ed25519Signature2020 } from '@interop/ed25519-signature';
import { ZcapClient } from '@interop/ezcap';
import { WasClient } from '@interop/was-client';
import { createEdvEncryption, ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv';
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key';

const API_BASE = (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, '');
const EMAIL = process.env.DEMO_EMAIL;
const PASSPHRASE = process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou';
const COLLECTION = 'UniversityOfToronto';
const FIXTURE = new URL('../fixtures/PlaywrightUpload.json', import.meta.url);

if (!EMAIL) {
  console.error('Set DEMO_EMAIL to the demo account\'s email.');
  process.exit(2);
}

// The same derivations the wallet uses: SHA-256 of the passphrase is the
// Ed25519 seed (src/lib/login.ts); the X25519 key-agreement key is converted
// from it (src/lib/edv.ts).
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PASSPHRASE));
const edKey = await Ed25519VerificationKey.generate({ seed: new Uint8Array(digest) });
edKey.controller = `did:key:${edKey.fingerprint()}`;
edKey.id = `${edKey.controller}#${edKey.fingerprint()}`;
const exported = await edKey.export({ secretKey: true });
const keyAgreementKey = X25519KeyAgreementKey2020.fromEd25519({
  controller: edKey.controller,
  publicKeyMultibase: exported.publicKeyMultibase,
  privateKeyMultibase: exported.secretKeyMultibase,
});
keyAgreementKey.id ??= `${edKey.controller}#${keyAgreementKey.fingerprint()}`;
const encryption = createEdvEncryption({
  resolveKeys: async () => ({
    keyAgreementKey,
    keyResolver: async () => {
      throw new Error('unexpected keystore resolver call');
    },
  }),
});

// Log in to learn the account's Main Space URL.
const zcapClient = new ZcapClient({ SuiteClass: Ed25519Signature2020, invocationSigner: edKey.signer() });
const login = await zcapClient.request({ url: `${API_BASE}/login`, method: 'POST', action: 'write', json: { email: EMAIL } });
const spaceUrl = login.data.space;
if (!spaceUrl) {
  console.error('The account has no credential space yet (registration not confirmed?).');
  process.exit(1);
}
const [, serverUrl, spaceId] = spaceUrl.match(/^(.+)\/space\/([^/]+)\/?$/);
console.log(`space ${spaceUrl}`);

const was = await WasClient.fromSigner({ serverUrl, signer: edKey.signer(), encryption });
const space = was.space(spaceId);

let collection = space.collection(COLLECTION);
const described = await collection.describe();
if (described === null) {
  collection = await space.createCollection({ id: COLLECTION, encryption: { scheme: 'edv' } });
  console.log(`created collection ${COLLECTION}`);
} else if (!described.encryption) {
  console.error(`Collection ${COLLECTION} exists and is not encrypted.`);
  process.exit(1);
}
await ensureFirstEpoch({ collection, recipients: [ownerRecipient({ keyAgreementKey })] });
const meta = await collection.meta();
if (!meta?.custom?.name) {
  await collection.setMeta({ custom: { name: COLLECTION } });
  console.log('named the collection');
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const fixtureName = fixture.verifiableCredential?.[0]?.name ?? fixture.name;
const listing = await collection.list();
let present = false;
for (const item of listing?.items ?? []) {
  const stored = await collection.get(item.id).catch(() => null);
  const name = stored?.verifiableCredential?.[0]?.name ?? stored?.name;
  if (name === fixtureName) {
    present = true;
    break;
  }
}
if (present) {
  console.log(`"${fixtureName}" is already there`);
} else {
  const added = await collection.add(fixture);
  console.log(`added "${fixtureName}" as ${added.id}`);
}
console.log('done');
