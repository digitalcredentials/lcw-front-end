// Pre-share credential verification via @digitalcredentials/verifier-core —
// the same package (and semantics) VerifierPlus uses. The core returns a
// per-check log with no overall flag; the consumer decides. "Fully verifies"
// here means every check passed: signature, expiration, revocation status,
// and registered issuer — with one VerifierPlus-matching exception: a
// revocation status list that cannot be fetched is treated as unchecked, not
// as a failure.
import { verifyCredential } from '@digitalcredentials/verifier-core';

interface VerificationStep {
  id: string;
  valid?: boolean;
  error?: { name?: string; message?: string };
}

export interface CoreVerificationResult {
  log?: VerificationStep[];
  errors?: { name?: string; message?: string }[];
}

export interface ShareVerification {
  ok: boolean;
  problems: string[];
}

const CHECK_PROBLEMS: Record<string, string> = {
  valid_signature: 'the signature is invalid',
  expiration: 'the credential has expired',
  revocation_status: 'the credential has been revoked',
  registered_issuer: 'the issuer is not in a known registry',
};

// Turns a verifier-core result into an ok/problems pair (pure; unit-tested).
export function interpretVerification(result: CoreVerificationResult): ShareVerification {
  if (result.errors?.length) {
    return { ok: false, problems: [result.errors[0].message ?? 'the credential could not be verified'] };
  }
  const log = (result.log ?? []).filter(
    (step) => !(step.id === 'revocation_status' && step.error?.name === 'status_list_not_found')
  );
  const failed = log.filter((step) => step.valid !== true);
  return {
    ok: log.length > 0 && failed.length === 0,
    problems: failed.map((step) => CHECK_PROBLEMS[step.id] ?? `the "${step.id}" check failed`),
  };
}

// The DCC-maintained list of known issuer registries, fetched once per page
// load (VerifierPlus fetches the same URL).
const REGISTRIES_URL =
  'https://digitalcredentials.github.io/dcc-known-registries/known-did-registries.json';
let registriesPromise: Promise<object> | null = null;

export function knownDIDRegistries(): Promise<object> {
  registriesPromise ??= fetch(REGISTRIES_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load the known registries (${response.status}).`);
      }
      return response.json();
    })
    .catch((err) => {
      // Any failure, the network included, is forgotten so the next call
      // tries again rather than reusing the rejection for the page's life.
      registriesPromise = null;
      throw err;
    });
  return registriesPromise;
}

// Verifies one credential for sharing. Never throws: when verification itself
// cannot run, the result is a warning, not a blocked share.
export async function verifyForSharing(credential: object): Promise<ShareVerification> {
  try {
    const result = (await verifyCredential({
      credential: credential as Parameters<typeof verifyCredential>[0]['credential'],
      knownDIDRegistries: await knownDIDRegistries(),
    })) as CoreVerificationResult;
    return interpretVerification(result);
  } catch (err) {
    console.error('Verification failed to run:', err);
    return { ok: false, problems: ['verification could not run'] };
  }
}
