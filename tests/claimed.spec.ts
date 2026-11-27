import { test, expect } from '@playwright/test';
import { claimedCredentials, listed, saveClaimed, sharedSuggestion } from '../src/lib/claimed';

// Node-side unit assertions over what the claim page does with an
// exchange's answer; no browser involved (the CHAPI mediator itself is not
// reliably automatable, so the popup flow is verified by running it).

const certificate = { type: ['VerifiableCredential'], name: 'Certificate of Qualification' };
const licence = { type: ['VerifiableCredential'], name: 'Master Electrician Licence' };

test('takes every credential of the answer, in the issuer order', () => {
  expect(claimedCredentials({ verifiableCredential: [certificate, licence] })).toEqual([certificate, licence]);
});

test('takes a single credential, listed or bare', () => {
  expect(claimedCredentials({ verifiableCredential: [certificate] })).toEqual([certificate]);
  expect(claimedCredentials({ verifiableCredential: certificate })).toEqual([certificate]);
});

test('an answer with no credential gives none', () => {
  expect(claimedCredentials(undefined)).toEqual([]);
  expect(claimedCredentials({})).toEqual([]);
  expect(claimedCredentials({ verifiableCredential: [] })).toEqual([]);
  // Not credentials: a string (an enveloped form this wallet does not read)
  expect(claimedCredentials({ verifiableCredential: ['eyJhbGciOi', null, certificate] })).toEqual([certificate]);
});

test('saves every credential once', async () => {
  const stored: unknown[] = [];
  const saved = new Set<number>();
  await saveClaimed({ credentials: [certificate, licence], saved, save: async (credential) => void stored.push(credential) });
  expect(stored).toEqual([certificate, licence]);
  expect([...saved]).toEqual([0, 1]);
});

test('a save pressed again after a failure stores only what is missing', async () => {
  const stored: unknown[] = [];
  const saved = new Set<number>();
  let failing = true;
  const save = async (credential: Record<string, unknown>) => {
    if (failing && credential === licence) {
      throw new Error('the server could not be reached');
    }
    stored.push(credential);
  };
  await expect(saveClaimed({ credentials: [certificate, licence], saved, save })).rejects.toThrow('could not be reached');
  expect(stored).toEqual([certificate]);
  expect([...saved]).toEqual([0]);

  failing = false;
  await saveClaimed({ credentials: [certificate, licence], saved, save });
  // The certificate is not stored a second time
  expect(stored).toEqual([certificate, licence]);
});

test('suggests a tag only when every credential suggests the same one', () => {
  expect(sharedSuggestion(['Badges'])).toBe('Badges');
  expect(sharedSuggestion(['Badges', 'Badges'])).toBe('Badges');
  expect(sharedSuggestion(['Certificates', 'Licenses and certifications'])).toBe('');
  expect(sharedSuggestion([])).toBe('');
});

test('names what was saved', () => {
  expect(listed(['A'])).toBe('A');
  expect(listed(['A', 'B'])).toBe('A and B');
  expect(listed(['A', 'B', 'C'])).toBe('A, B and C');
});
