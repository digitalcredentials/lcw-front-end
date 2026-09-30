// Builds LinkedIn's add-to-profile URL from a stored credential — the same
// mechanism as the mobile wallet's "Add to LinkedIn Profile"
// (learner-credential-wallet app/lib/publicLink.ts linkedinUrlFrom), with two
// deliberate differences: every parameter is URL-encoded (the mobile version
// concatenates raw values, which breaks a certUrl containing ? or #), and a
// credential without an issuer name omits organizationName rather than
// sending the literal string "undefined".

interface Achievement {
  name?: unknown;
}

export interface CredentialLike {
  type?: unknown;
  name?: unknown;
  issuer?: unknown;
  validFrom?: unknown;
  issuanceDate?: unknown;
  validUntil?: unknown;
  expirationDate?: unknown;
  credentialSubject?: {
    hasCredential?: Achievement | Achievement[];
    achievement?: Achievement | Achievement[];
  };
}

// Stored wallet resources are either a presentation envelope
// ({verifiableCredential: [vc]}) or a bare credential. Returns the credential
// when the data looks like one, else null.
export function credentialFrom(data: unknown): CredentialLike | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const envelope = data as { verifiableCredential?: unknown[] };
  const candidate = (Array.isArray(envelope.verifiableCredential)
    ? envelope.verifiableCredential[0]
    : data) as CredentialLike;
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const types = [candidate.type ?? []].flat();
  if (!types.includes('VerifiableCredential') && !candidate.credentialSubject) {
    return null;
  }
  return candidate;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// VC 2.0 field first, then the v1 equivalent — the mobile wallet's order.
export function credentialIssuance(credential: CredentialLike): Date | null {
  return parseDate(credential.validFrom) ?? parseDate(credential.issuanceDate);
}

export function credentialExpiration(credential: CredentialLike): Date | null {
  return parseDate(credential.validUntil) ?? parseDate(credential.expirationDate);
}

// The issuer's display name; null when the issuer is absent, a bare string
// (a DID), or an object without a name.
export function issuerName(credential: CredentialLike): string | null {
  const issuer = credential.issuer;
  if (typeof issuer === 'object' && issuer !== null) {
    const name = (issuer as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }
  return null;
}

// The credential's display name: the achievement's (Open Badges
// credentialSubject.hasCredential ?? credentialSubject.achievement, first
// element when an array), else the credential's own name, else the mobile
// wallet's fallback.
export function credentialName(credential: CredentialLike): string {
  const subject = credential.credentialSubject;
  const eoc = [subject?.hasCredential ?? subject?.achievement ?? []].flat()[0];
  const name = eoc?.name ?? credential.name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Verifiable Credential';
}

export function linkedinAddToProfileUrl({
  credential,
  certUrl,
}: {
  credential: CredentialLike;
  certUrl: string;
}): string {
  const params = new URLSearchParams({ startTask: 'CERTIFICATION_NAME' });
  params.set('name', credentialName(credential));
  const organization = issuerName(credential);
  if (organization) {
    params.set('organizationName', organization);
  }
  const issued = credentialIssuance(credential);
  if (issued) {
    params.set('issueYear', String(issued.getFullYear()));
    params.set('issueMonth', String(issued.getMonth() + 1));
  }
  const expires = credentialExpiration(credential);
  if (expires) {
    params.set('expirationYear', String(expires.getFullYear()));
    params.set('expirationMonth', String(expires.getMonth() + 1));
  }
  params.set('certUrl', certUrl);
  return `https://www.linkedin.com/profile/add?${params.toString()}`;
}
