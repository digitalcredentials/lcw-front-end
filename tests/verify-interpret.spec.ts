import { test, expect } from '@playwright/test';
import { interpretVerification } from '../src/lib/verify';

// Node-side unit assertions over the pure verifier-core result interpreter
// (the network-touching verifyForSharing is exercised manually against the
// deployed wallet).

test('an all-valid log fully verifies', () => {
  const result = interpretVerification({
    log: [
      { id: 'valid_signature', valid: true },
      { id: 'expiration', valid: true },
      { id: 'revocation_status', valid: true },
      { id: 'registered_issuer', valid: true },
    ],
  });
  expect(result.ok).toBe(true);
  expect(result.problems).toEqual([]);
});

test('a failed check yields its problem text', () => {
  const result = interpretVerification({
    log: [
      { id: 'valid_signature', valid: false },
      { id: 'expiration', valid: true },
      { id: 'registered_issuer', valid: false },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    'the signature is invalid',
    'the issuer is not in a known registry',
  ]);
});

test('an unreachable status list is unchecked, not a failure', () => {
  const result = interpretVerification({
    log: [
      { id: 'valid_signature', valid: true },
      { id: 'expiration', valid: true },
      { id: 'revocation_status', error: { name: 'status_list_not_found', message: 'gone' } },
    ],
  });
  expect(result.ok).toBe(true);
});

test('a fatal error reports its message and fails', () => {
  const result = interpretVerification({
    errors: [{ name: 'no_proof', message: 'The credential carries no proof.' }],
  });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual(['The credential carries no proof.']);
});

test('an empty or missing log does not count as verified', () => {
  expect(interpretVerification({}).ok).toBe(false);
  expect(interpretVerification({ log: [] }).ok).toBe(false);
});

test('an unknown check id still surfaces as a problem', () => {
  const result = interpretVerification({
    log: [{ id: 'some_future_check', valid: false }],
  });
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual(['the "some_future_check" check failed']);
});
