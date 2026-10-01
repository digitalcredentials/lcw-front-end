import { test, expect } from '@playwright/test';
import {
  parsePresentationRequest,
  credentialMatchesExample,
  matchesAnyExample,
  buildPresentation,
} from '../src/lib/vpRequest';

// Node-side unit assertions over the pure presentation-request helpers; no
// browser involved (the CHAPI mediator itself is not reliably automatable, so
// the popup flow is verified manually).

// The exact payload VerifierPlus's 'Request from web wallet via CHAPI' sends
// (web-verifier-plus/app/page.tsx).
const VERIFIER_PLUS_VPR = {
  query: [
    {
      type: 'QueryByExample',
      credentialQuery: {
        reason: 'VerifierPlus is requesting any credential for verification.',
        example: { type: ['VerifiableCredential'] },
      },
    },
  ],
};

const CREDENTIAL = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  issuer: { id: 'did:key:z6MkIssuer', name: 'DCC' },
  credentialSubject: { id: 'did:key:z6MkHolder', name: 'Ada' },
};

test('parses the VerifierPlus request', () => {
  const parsed = parsePresentationRequest(VERIFIER_PLUS_VPR);
  expect(parsed).not.toBeNull();
  expect(parsed!.examples).toHaveLength(1);
  expect(parsed!.reasons).toEqual(['VerifierPlus is requesting any credential for verification.']);
  expect(parsed!.didAuth).toBe(false);
  expect(parsed!.challenge).toBeUndefined();
});

test('accepts query as a single object and credentialQuery as an array', () => {
  const parsed = parsePresentationRequest({
    query: {
      type: 'QueryByExample',
      credentialQuery: [
        { example: { type: ['VerifiableCredential'] } },
        { reason: 'second', example: { type: ['OpenBadgeCredential'] } },
      ],
    },
  });
  expect(parsed!.examples).toHaveLength(2);
  expect(parsed!.reasons).toEqual(['second']);
});

test('detects DIDAuthentication alongside QueryByExample, with challenge and domain', () => {
  const parsed = parsePresentationRequest({
    query: [
      { type: 'DIDAuthentication' },
      { type: 'QueryByExample', credentialQuery: { example: {} } },
    ],
    challenge: 'abc',
    domain: 'https://verifier.example',
  });
  expect(parsed!.didAuth).toBe(true);
  expect(parsed!.challenge).toBe('abc');
  expect(parsed!.domain).toBe('https://verifier.example');
});

test('a request without QueryByExample is not a presentation request', () => {
  expect(parsePresentationRequest({ query: [{ type: 'DIDAuthentication' }] })).toBeNull();
  expect(parsePresentationRequest({ interact: { service: [] } })).toBeNull();
  expect(parsePresentationRequest(undefined)).toBeNull();
});

test('matching: array values are subset matches', () => {
  expect(credentialMatchesExample(CREDENTIAL, { type: ['VerifiableCredential'] })).toBe(true);
  expect(credentialMatchesExample(CREDENTIAL, { type: ['VerifiableCredential', 'OpenBadgeCredential'] })).toBe(true);
  expect(credentialMatchesExample(CREDENTIAL, { type: ['DriversLicense'] })).toBe(false);
});

test('matching: nested objects recurse, literals compare strictly', () => {
  expect(credentialMatchesExample(CREDENTIAL, { issuer: { name: 'DCC' } })).toBe(true);
  expect(credentialMatchesExample(CREDENTIAL, { issuer: { name: 'Other' } })).toBe(false);
  expect(credentialMatchesExample(CREDENTIAL, { credentialSubject: { name: 'Ada' } })).toBe(true);
});

test('matchesAnyExample: any one example suffices', () => {
  const parsed = parsePresentationRequest({
    query: [{
      type: 'QueryByExample',
      credentialQuery: [
        { example: { type: ['DriversLicense'] } },
        { example: { type: ['OpenBadgeCredential'] } },
      ],
    }],
  });
  expect(matchesAnyExample(CREDENTIAL, parsed!)).toBe(true);
});

test('buildPresentation shapes an unsigned VP', () => {
  const vp = buildPresentation({ credentials: [CREDENTIAL], holder: 'did:key:z6MkHolder' });
  expect(vp['@context']).toEqual(['https://www.w3.org/ns/credentials/v2']);
  expect(vp.type).toEqual(['VerifiablePresentation']);
  expect(vp.holder).toBe('did:key:z6MkHolder');
  expect(vp.verifiableCredential).toEqual([CREDENTIAL]);
  expect('holder' in buildPresentation({ credentials: [] })).toBe(false);
});
