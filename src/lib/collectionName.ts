// Which collection a claimed credential is offered: a category read from its
// Open Badges achievement type ("Degrees", "Certificates", …), so a person's
// collections stay few and like credentials gather together. Also the
// browser's memory of the collection this account last saved into.

// Open Badges 3.0 achievementType terms, lower-cased, to the category offered.
const CATEGORIES: Record<string, string> = {
  associatedegree: 'Degrees',
  bachelordegree: 'Degrees',
  degree: 'Degrees',
  doctoraldegree: 'Degrees',
  masterdegree: 'Degrees',
  professionaldoctorate: 'Degrees',
  researchdoctorate: 'Degrees',
  diploma: 'Diplomas',
  secondaryschooldiploma: 'Diplomas',
  generaleducationdevelopment: 'Diplomas',
  certificate: 'Certificates',
  certificateofcompletion: 'Certificates',
  apprenticeshipcertificate: 'Certificates',
  journeymancertificate: 'Certificates',
  mastercertificate: 'Certificates',
  certification: 'Licenses and certifications',
  license: 'Licenses and certifications',
  qualityassurancecredential: 'Licenses and certifications',
  course: 'Courses',
  learningprogram: 'Courses',
  assessment: 'Courses',
  assignment: 'Courses',
  fieldwork: 'Courses',
  badge: 'Badges',
  microcredential: 'Badges',
  competency: 'Badges',
  achievement: 'Badges',
  award: 'Awards',
  cocurricular: 'Activities',
  communityservice: 'Activities',
  membership: 'Activities',
};

const FALLBACK = 'Credentials';

// The wallet's own collections, which the save picker never offers; an
// issuer-chosen extension must not name one of them.
const RESERVED = ['trash', 'dids', 'public'];

// The achievement's type: credentialSubject (first entry when an array), then
// hasCredential ?? achievement (first element when an array), as
// credentialName reads the achievement.
function achievementTypeOf(credential: Record<string, unknown>): string | null {
  const subject = [credential.credentialSubject ?? []].flat()[0] as
    | { hasCredential?: unknown; achievement?: unknown }
    | undefined;
  const achievement = [subject?.hasCredential ?? subject?.achievement ?? []].flat()[0] as
    | { achievementType?: unknown }
    | undefined;
  const type = achievement?.achievementType;
  return typeof type === 'string' && type.trim() ? type.trim() : null;
}

// An extension's own words: "ext:" dropped, underscores as spaces, and a
// capital starting a new word only when a lowercase letter follows it, so
// "VolunteerWork" reads "Volunteer Work" and "PhDProgram" "PhD Program".
// The issuer writes this text and it becomes a collection id (a path
// segment, and half of the picker's "<spaceUrl>|<id>" value), so anything
// but letters, digits, apostrophes and dashes becomes a space.
function extensionWords(type: string): string {
  return type
    .replace(/^ext:/i, '')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/(?<=[\p{L}\p{N}])(?=\p{Lu}\p{Ll})/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function suggestCollectionName(credential: Record<string, unknown>): string {
  const type = achievementTypeOf(credential);
  if (!type) {
    return FALLBACK;
  }
  if (/^ext:/i.test(type)) {
    const words = extensionWords(type);
    return words && !RESERVED.includes(collectionIdFor(words).toLowerCase()) ? words : FALLBACK;
  }
  return CATEGORIES[type.toLowerCase()] ?? FALLBACK;
}

// A new collection's id: its name with whitespace dashed (the id becomes a
// path segment). Listings report an encrypted collection's id as its name,
// so matching a suggestion against existing collections compares ids too.
export function collectionIdFor(name: string): string {
  return name.trim().replace(/\s+/g, '-');
}

// The collection this account last saved into in this browser, as the save
// picker's own value: "<spaceUrl>|<collectionId>". Storage may be blocked (a
// private window), which only loses the memory.
function lastCollectionKey(email: string): string {
  return `lcw_last_collection:${email}`;
}

export function lastCollection(email: string | null): string | null {
  if (!email) {
    return null;
  }
  try {
    return localStorage.getItem(lastCollectionKey(email));
  } catch {
    return null;
  }
}

export function rememberLastCollection(email: string | null, value: string): void {
  if (!email) {
    return;
  }
  try {
    localStorage.setItem(lastCollectionKey(email), value);
  } catch (err) {
    console.error('Could not remember the last collection:', err);
  }
}
