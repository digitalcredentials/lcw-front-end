// Drives the wallet's claim flow (the same steps src/lib/claim.ts performs,
// minus the WAS DID storage) against a deployed issuer, without CHAPI.
//
//   node tests/scripts/claim-wire.mjs [exchange-api-base]
import '@interop/http-client';
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key';
import { Ed25519Signature2020 } from '@interop/ed25519-signature';
import { securityLoader } from '@interop/security-document-loader';
import jsigs from '@interop/jsonld-signatures';

const API = (process.argv[2] ?? 'https://ko29d8ljta.execute-api.us-east-1.amazonaws.com').replace(/\/+$/, '');
const documentLoader = securityLoader().build();

const created = await (await fetch(`${API}/workflows/lcw-sandbox-badge/exchanges`, { method: 'POST' })).json();
const exchangeUrl = created.verifiablePresentationRequest.interact.service[0].serviceEndpoint;
console.log('exchange:', created.exchangeId);

const { verifiablePresentationRequest: vpr } = await (await fetch(exchangeUrl, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
})).json();
console.log('DIDAuth challenge received:', !!vpr.challenge);

const key = await Ed25519VerificationKey.generate();
const holderDid = `did:key:${key.fingerprint()}`;
key.controller = holderDid;
key.id = `${holderDid}#${key.fingerprint()}`;

const signedVp = await jsigs.sign({
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/suites/ed25519-2020/v1'],
  type: ['VerifiablePresentation'],
  holder: holderDid
}, {
  suite: new Ed25519Signature2020({ signer: key.signer() }),
  purpose: new jsigs.purposes.AuthenticationProofPurpose({ challenge: vpr.challenge, domain: vpr.domain }),
  documentLoader
});

const res = await fetch(exchangeUrl, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ verifiablePresentation: signedVp })
});
const result = await res.json();
const credential = result.verifiablePresentation?.verifiableCredential?.[0];
console.log(`issue -> ${res.status}`);
console.log('credential:', credential?.name, '| bound to holder:', credential?.credentialSubject?.id === holderDid);
console.log('issuer:', credential?.issuer?.id);
process.exit(res.status === 200 && credential?.credentialSubject?.id === holderDid ? 0 : 1);
