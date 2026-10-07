import { test, expect } from '@playwright/test';
import { credentialRecipient, credentialRole, credentialActivityDates, type CredentialLike } from '../src/lib/linkedin';

// Node-side unit assertions over the Open Badges subject fields shown in the
// credential detail summary.

// An Open Badges 3.0 employment credential's subject: the name is carried in
// an unhashed IdentityObject, not credentialSubject.name.
const employment = {
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  credentialSubject: {
    type: ['AchievementSubject'],
    identifier: [{ type: 'IdentityObject', identityHash: 'Alex Rivera', identityType: 'name', hashed: false }],
    role: 'Software Engineer',
    activityStartDate: '2025-03-01T00:00:00Z',
    activityEndDate: '2026-09-30T00:00:00Z',
    achievement: { name: 'Employment at Example Org' },
  },
} as CredentialLike;

test('the recipient is read from an unhashed Open Badges identifier', () => {
  expect(credentialRecipient(employment)).toBe('Alex Rivera');
});

test('credentialSubject.name is preferred when present', () => {
  const named = { credentialSubject: { ...employment.credentialSubject, name: 'A. Rivera' } } as CredentialLike;
  expect(credentialRecipient(named)).toBe('A. Rivera');
});

test('a hashed identifier is not shown as the recipient', () => {
  const hashed = {
    credentialSubject: {
      identifier: { type: 'IdentityObject', identityHash: 'sha256$abc', identityType: 'name', hashed: true },
    },
  } as CredentialLike;
  expect(credentialRecipient(hashed)).toBeNull();
});

test('only a name identifier is shown as the recipient, not an email or ID', () => {
  const ids = {
    credentialSubject: {
      identifier: [
        { type: 'IdentityObject', identityHash: 'S-004417', identityType: 'studentId', hashed: false },
        { type: 'IdentityObject', identityHash: 'alex@example.org', identityType: 'emailAddress' },
        { type: 'IdentityObject', identityHash: 'Alex Rivera', identityType: 'name', hashed: false },
      ],
    },
  } as CredentialLike;
  expect(credentialRecipient(ids)).toBe('Alex Rivera');
  const emailOnly = {
    credentialSubject: {
      identifier: [{ type: 'IdentityObject', identityHash: 'alex@example.org', identityType: 'emailAddress', hashed: false }],
    },
  } as CredentialLike;
  expect(credentialRecipient(emailOnly)).toBeNull();
});

test('role and activity dates are read from the subject', () => {
  expect(credentialRole(employment)).toBe('Software Engineer');
  const { start, end } = credentialActivityDates(employment);
  expect(start?.toISOString()).toBe('2025-03-01T00:00:00.000Z');
  expect(end?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
});

test('activity dates keep the calendar day the issuer wrote', () => {
  const at = (activityStartDate: string) =>
    credentialActivityDates({ credentialSubject: { activityStartDate } }).start?.toISOString() ?? null;
  expect(at('2025-03-01T00:00:00+09:00')).toBe('2025-03-01T00:00:00.000Z');
  expect(at('2025-03-01T23:30:00-08:00')).toBe('2025-03-01T00:00:00.000Z');
  expect(at('2025-03-01')).toBe('2025-03-01T00:00:00.000Z');
  expect(at('March 1, 2025')).toBeNull();
  expect(at('2025-02-30')).toBeNull();
});

test('a credential without role or activity dates yields nulls', () => {
  const plain = { credentialSubject: { name: 'Alex Rivera' } } as CredentialLike;
  expect(credentialRole(plain)).toBeNull();
  expect(credentialActivityDates(plain)).toEqual({ start: null, end: null });
});
