import { test, expect } from '@playwright/test';
import { shareStatus } from '../src/lib/shareStatus';
import type { ShareVerification } from '../src/lib/verify';

// Node-side unit assertions over the share dialog's status line wording.

const DCC = { issuer: 'Digital Credentials Commons', expired: '6/30/2026' };

function failed(ids: string[], signatureValid = true): ShareVerification {
  return { ok: false, problems: [], failed: ids, signatureValid };
}

test('no status line when every check passes', () => {
  expect(shareStatus({ ok: true, problems: [], failed: [], signatureValid: true }, DCC)).toBeNull();
});

test('an issuer not on the list', () => {
  expect(shareStatus(failed(['registered_issuer']), DCC)).toEqual({
    line: "Digital Credentials Commons isn't on our list of known issuers. Some people may not accept it.",
    list: [],
    detail: "Only a small share of issuers are on the list so far, so this is common. The signature is valid, so the information hasn't changed since it was issued. You can still share it.",
  });
});

test('the signature sentence appears only when the signature check passed', () => {
  expect(shareStatus(failed(['registered_issuer'], false), DCC)?.detail).toBe(
    'Only a small share of issuers are on the list so far, so this is common. You can still share it.'
  );
});

test('an issuer without a name', () => {
  expect(shareStatus(failed(['registered_issuer']), { issuer: null, expired: null })?.line).toBe(
    "The issuer isn't on our list of known issuers. Some people may not accept it."
  );
});

test('an expired credential', () => {
  expect(shareStatus(failed(['expiration']), DCC)).toEqual({
    line: 'This credential expired on 6/30/2026. Some people may not accept it.',
    list: [],
    detail: 'The issuer set an end date and it has passed. The signature is valid, and you can still share it.',
  });
});

test('other failures use the verifier plugin headlines', () => {
  expect(shareStatus(failed(['revocation_status']), DCC)?.line).toBe(
    'The issuer has deactivated this copy. Some people may not accept it.'
  );
  expect(shareStatus(failed(['valid_signature'], false), DCC)?.line).toBe(
    'This credential has been tampered with. Some people may not accept it.'
  );
  expect(shareStatus(failed(['could_not_run'], false), DCC)?.line).toBe(
    "We couldn't check this right now. Some people may not accept it."
  );
  expect(shareStatus(failed(['fatal'], false), DCC)).toEqual({
    line: "We can't check this credential. Some people may not accept it.",
    list: [],
    detail: 'You can still share it.',
  });
});

test('several problems lead with the most serious and list them all', () => {
  expect(shareStatus(failed(['registered_issuer', 'expiration']), DCC)).toEqual({
    line: 'This credential expired on 6/30/2026. Some people may not accept it.',
    list: [
      'This credential expired on 6/30/2026. The issuer set an end date and it has passed.',
      "Digital Credentials Commons isn't on our list of known issuers. Only a small share of issuers are on the list so far, so this is common.",
    ],
    detail: "The signature is valid, so the information hasn't changed since it was issued. You can still share it.",
  });
  expect(shareStatus(failed(['registered_issuer', 'valid_signature'], false), DCC)?.line).toBe(
    'This credential has been tampered with. Some people may not accept it.'
  );
});
