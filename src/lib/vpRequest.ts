// Parsing and matching for incoming Verifiable Presentation Requests — a
// verifier asking this wallet FOR credentials (e.g. VerifierPlus's 'Request
// from web wallet via CHAPI'). The matching rules are the mobile wallet's
// (learner-credential-wallet app/lib/credentialMatching.ts): an array value in
// the example must be a subset of the credential's array, an object value
// recurses, a literal must be strictly equal.

export interface ExampleQuery {
  reason?: string;
  example: Record<string, unknown>;
}

export interface ParsedPresentationRequest {
  examples: ExampleQuery[];
  // Reasons in query order, for the consent prompt
  reasons: string[];
  // True when the query set contains DIDAuthentication/DIDAuth: the response
  // should be signed by the holder when a challenge is present
  didAuth: boolean;
  challenge?: string;
  domain?: string;
}

// Returns the parsed request when the VPR contains at least one
// QueryByExample; null otherwise (such requests stay on the claim path).
export function parsePresentationRequest(
  vpr: Record<string, unknown> | undefined
): ParsedPresentationRequest | null {
  if (!vpr) {
    return null;
  }
  const queries = [vpr.query ?? []].flat() as {
    type?: string;
    credentialQuery?: ExampleQuery | ExampleQuery[];
  }[];

  const examples: ExampleQuery[] = [];
  let didAuth = false;
  for (const query of queries) {
    if (query?.type === 'QueryByExample') {
      for (const credentialQuery of [query.credentialQuery ?? []].flat()) {
        examples.push({
          reason: typeof credentialQuery.reason === 'string' ? credentialQuery.reason : undefined,
          example:
            typeof credentialQuery.example === 'object' && credentialQuery.example !== null
              ? credentialQuery.example
              : {},
        });
      }
    } else if (query?.type === 'DIDAuthentication' || query?.type === 'DIDAuth') {
      didAuth = true;
    }
  }
  if (!examples.length) {
    return null;
  }
  return {
    examples,
    reasons: examples.flatMap(({ reason }) => (reason ? [reason] : [])),
    didAuth,
    challenge: typeof vpr.challenge === 'string' ? vpr.challenge : undefined,
    domain: typeof vpr.domain === 'string' ? vpr.domain : undefined,
  };
}

// The mobile wallet's example-matching rules, as a plain recursive walk.
export function credentialMatchesExample(credential: unknown, example: Record<string, unknown>): boolean {
  if (typeof credential !== 'object' || credential === null) {
    return false;
  }
  const subject = credential as Record<string, unknown>;
  return Object.entries(example).every(([key, wanted]) => {
    const actual = subject[key];
    if (Array.isArray(wanted)) {
      const actualArray = [actual ?? []].flat();
      return wanted.every((value) => actualArray.includes(value));
    }
    if (typeof wanted === 'object' && wanted !== null) {
      return credentialMatchesExample(actual, wanted as Record<string, unknown>);
    }
    return actual === wanted;
  });
}

export function matchesAnyExample(credential: unknown, parsed: ParsedPresentationRequest): boolean {
  return parsed.examples.some(({ example }) => credentialMatchesExample(credential, example));
}

// An unsigned response presentation carrying the selected (bare) credentials.
export function buildPresentation({
  credentials,
  holder,
}: {
  credentials: unknown[];
  holder?: string;
}): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiablePresentation'],
    ...(holder && { holder }),
    verifiableCredential: credentials,
  };
}
