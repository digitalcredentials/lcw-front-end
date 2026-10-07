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
    name?: unknown;
    identifier?: unknown;
    role?: unknown;
    activityStartDate?: unknown;
    activityEndDate?: unknown;
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

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// The issuer's display name; null when the issuer is absent, a bare string
// (a DID), or an object without a name.
export function issuerName(credential: CredentialLike): string | null {
  const issuer = credential.issuer;
  if (typeof issuer === 'object' && issuer !== null) {
    return nonEmpty((issuer as { name?: unknown }).name);
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
  return nonEmpty(eoc?.name ?? credential.name) ?? 'Verifiable Credential';
}

// Who the credential was issued to: credentialSubject.name, else the first
// Open Badges identifier that carries a plain name (identityType "name", not
// hashed); null when neither is present. Other identity types, such as an
// email address or a student ID, are not names and are not shown here.
export function credentialRecipient(credential: CredentialLike): string | null {
  const subject = credential.credentialSubject;
  const name = nonEmpty(subject?.name);
  if (name) {
    return name;
  }
  const identifiers = [subject?.identifier ?? []].flat() as Array<
    { identityType?: unknown; identityHash?: unknown; hashed?: unknown } | null | undefined
  >;
  const plain = identifiers.find((i) => i?.identityType === 'name' && i.hashed !== true);
  return nonEmpty(plain?.identityHash);
}

// The recipient's role in the recorded activity (Open Badges
// credentialSubject.role), such as a job title.
export function credentialRole(credential: CredentialLike): string | null {
  return nonEmpty(credential.credentialSubject?.role);
}

// A calendar date as the issuer wrote it: the YYYY-MM-DD at the start of an
// ISO 8601 date or date-time, as midnight UTC, ignoring any time or offset so
// that formatting it in UTC shows the same day in every time zone. Null when
// the value doesn't start with a valid date.
function calendarDate(value: unknown): Date | null {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

// When the recorded activity started and ended (Open Badges
// credentialSubject.activityStartDate / activityEndDate) as calendar dates,
// to be formatted in UTC; each null when absent or not a date.
export function credentialActivityDates(credential: CredentialLike): { start: Date | null; end: Date | null } {
  const subject = credential.credentialSubject;
  return { start: calendarDate(subject?.activityStartDate), end: calendarDate(subject?.activityEndDate) };
}

// An image reference is either a URL string or an object with an id.
function imageUrl(image: unknown): string | null {
  if (typeof image === 'string' && image.trim()) {
    return image;
  }
  if (typeof image === 'object' && image !== null) {
    const id = (image as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) {
      return id;
    }
  }
  return null;
}

// The credential's own image: the achievement's (Open Badges), else the
// credential-level image.
export function credentialImage(credential: CredentialLike): string | null {
  const subject = credential.credentialSubject;
  const eoc = [subject?.hasCredential ?? subject?.achievement ?? []].flat()[0] as
    | { image?: unknown }
    | undefined;
  return imageUrl(eoc?.image) ?? imageUrl((credential as { image?: unknown }).image);
}

// The issuer's logo, when the issuer is an object carrying an image.
export function issuerImage(credential: CredentialLike): string | null {
  const issuer = credential.issuer;
  if (typeof issuer === 'object' && issuer !== null) {
    return imageUrl((issuer as { image?: unknown }).image);
  }
  return null;
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
