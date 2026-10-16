import { test, expect } from '@playwright/test';
import { linkedinAddToProfileUrl, type CredentialLike } from '../src/lib/linkedin';

// Node-side unit assertions over the add-to-profile link builder; no browser
// involved. The deployed test covers the same link end to end, against a real
// credential (tests/deployed.spec.ts).

const CERT_URL = 'https://verifierplus.org/#verify?vc=https://example.org/c/1';

const CREDENTIAL = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  name: 'Introduction to Verifiable Credentials',
  issuer: { id: 'did:key:z6MkIssuer', name: 'DCC' },
  credentialSubject: { id: 'did:key:z6MkHolder', name: 'Ada' },
};

function certIdOf(credential: CredentialLike): string | null {
  const url = new URL(linkedinAddToProfileUrl({ credential, certUrl: CERT_URL }));
  return url.searchParams.get('certId');
}

test('carries the credential id as the certification id', () => {
  expect(certIdOf({ ...CREDENTIAL, id: 'urn:uuid:5b2f1a0c-8f3e-4c21-9a77-2d6e0f8b3c44' })).toBe(
    'urn:uuid:5b2f1a0c-8f3e-4c21-9a77-2d6e0f8b3c44'
  );
});

test('carries an id of exactly LinkedIn\'s 80-character limit', () => {
  const id = `https://example.org/credentials/${'a'.repeat(80 - 'https://example.org/credentials/'.length)}`;
  expect(id).toHaveLength(80);
  expect(certIdOf({ ...CREDENTIAL, id })).toBe(id);
});

test('omits the certification id when the credential has none', () => {
  expect(certIdOf(CREDENTIAL)).toBeNull();
});

test('omits an id longer than 80 characters rather than truncating it', () => {
  const id = `urn:uuid:${'0123456789'.repeat(8)}`;
  expect(id.length).toBeGreaterThan(80);
  expect(certIdOf({ ...CREDENTIAL, id })).toBeNull();
});

test('omits an id that is blank or not a string', () => {
  expect(certIdOf({ ...CREDENTIAL, id: '' })).toBeNull();
  expect(certIdOf({ ...CREDENTIAL, id: '   ' })).toBeNull();
  expect(certIdOf({ ...CREDENTIAL, id: 42 })).toBeNull();
  expect(certIdOf({ ...CREDENTIAL, id: { id: 'urn:uuid:1' } })).toBeNull();
});

test('trims the id before measuring and sending it', () => {
  const id = `urn:uuid:${'a'.repeat(80 - 'urn:uuid:'.length)}`;
  expect(id).toHaveLength(80);
  // Surrounding whitespace neither pushes it over the limit nor reaches LinkedIn
  expect(certIdOf({ ...CREDENTIAL, id: `  ${id}  ` })).toBe(id);
});

for (const [label, id] of [
  ['with an id', 'urn:uuid:1'],
  ['without an id', undefined],
  ['with an id over the limit', `urn:uuid:${'0123456789'.repeat(8)}`],
] as const) {
  test(`leaves the rest of the form filled in ${label}`, () => {
    const url = new URL(linkedinAddToProfileUrl({ credential: { ...CREDENTIAL, id }, certUrl: CERT_URL }));
    expect(url.searchParams.get('startTask')).toBe('CERTIFICATION_NAME');
    expect(url.searchParams.get('name')).toBe('Introduction to Verifiable Credentials');
    expect(url.searchParams.get('organizationName')).toBe('DCC');
    expect(url.searchParams.get('certUrl')).toBe(CERT_URL);
  });
}
