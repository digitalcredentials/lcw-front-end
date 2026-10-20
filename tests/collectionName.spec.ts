import { test, expect } from '@playwright/test';
import { suggestCollectionName, collectionIdFor } from '../src/lib/collectionName';

// Node-side unit assertions over the collection suggestion; no browser
// involved. The claim page's use of it (the save picker's default) is checked
// by running the page.

function withType(achievementType?: unknown): Record<string, unknown> {
  return {
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    credentialSubject: { achievement: { name: 'Something', ...(achievementType !== undefined && { achievementType }) } },
  };
}

test('maps one term from each category', () => {
  expect(suggestCollectionName(withType('BachelorDegree'))).toBe('Degrees');
  expect(suggestCollectionName(withType('SecondarySchoolDiploma'))).toBe('Diplomas');
  expect(suggestCollectionName(withType('CertificateOfCompletion'))).toBe('Certificates');
  expect(suggestCollectionName(withType('License'))).toBe('Licenses and certifications');
  expect(suggestCollectionName(withType('Course'))).toBe('Courses');
  expect(suggestCollectionName(withType('MicroCredential'))).toBe('Badges');
  expect(suggestCollectionName(withType('Award'))).toBe('Awards');
  expect(suggestCollectionName(withType('CommunityService'))).toBe('Activities');
});

test('maps every Open Badges 3.0 term to a category', () => {
  const terms = [
    'Achievement', 'ApprenticeshipCertificate', 'Assessment', 'Assignment', 'AssociateDegree', 'Award',
    'Badge', 'BachelorDegree', 'Certificate', 'CertificateOfCompletion', 'Certification', 'CommunityService',
    'Competency', 'Course', 'CoCurricular', 'Degree', 'Diploma', 'DoctoralDegree', 'Fieldwork',
    'GeneralEducationDevelopment', 'JourneymanCertificate', 'LearningProgram', 'License', 'Membership',
    'ProfessionalDoctorate', 'QualityAssuranceCredential', 'MasterCertificate', 'MasterDegree',
    'MicroCredential', 'ResearchDoctorate', 'SecondarySchoolDiploma',
  ];
  for (const term of terms) {
    expect(suggestCollectionName(withType(term)), term).not.toBe('Credentials');
  }
});

test('matches terms without regard to case', () => {
  expect(suggestCollectionName(withType('bachelordegree'))).toBe('Degrees');
  expect(suggestCollectionName(withType('  CERTIFICATE  '))).toBe('Certificates');
});

test('reads an extension in its own words', () => {
  expect(suggestCollectionName(withType('ext:Employment'))).toBe('Employment');
  expect(suggestCollectionName(withType('EXT:Employment'))).toBe('Employment');
  expect(suggestCollectionName(withType('ext:VolunteerWork'))).toBe('Volunteer Work');
  expect(suggestCollectionName(withType('ext:PhDProgram'))).toBe('PhD Program');
  expect(suggestCollectionName(withType('ext:work_experience'))).toBe('work experience');
  expect(suggestCollectionName(withType('ext:Work experience'))).toBe('Work experience');
  expect(suggestCollectionName(withType('ext:'))).toBe('Credentials');
});

test('never names one of the wallet\'s own collections', () => {
  expect(suggestCollectionName(withType('ext:Trash'))).toBe('Credentials');
  expect(suggestCollectionName(withType('ext:dids'))).toBe('Credentials');
  expect(suggestCollectionName(withType('ext:PUBLIC'))).toBe('Credentials');
});

test('keeps only safe characters from an extension', () => {
  expect(suggestCollectionName(withType('ext:Work/Volunteer'))).toBe('Work Volunteer');
  expect(suggestCollectionName(withType('ext:A|B?#C'))).toBe('A B C');
  expect(suggestCollectionName(withType("ext:Children's-Programs"))).toBe("Children's-Programs");
  expect(suggestCollectionName(withType('ext:///'))).toBe('Credentials');
});

test('falls back to Credentials', () => {
  expect(suggestCollectionName(withType())).toBe('Credentials');
  expect(suggestCollectionName(withType(''))).toBe('Credentials');
  expect(suggestCollectionName(withType(42))).toBe('Credentials');
  expect(suggestCollectionName(withType('SomethingUnknown'))).toBe('Credentials');
  expect(suggestCollectionName({ type: ['VerifiableCredential'] })).toBe('Credentials');
});

test('reads an array credentialSubject, and hasCredential before achievement', () => {
  expect(suggestCollectionName({
    credentialSubject: [{ achievement: { achievementType: 'Diploma' } }, { achievement: { achievementType: 'Badge' } }],
  })).toBe('Diplomas');
  expect(suggestCollectionName({
    credentialSubject: { hasCredential: { achievementType: 'Course' }, achievement: { achievementType: 'Badge' } },
  })).toBe('Courses');
  expect(suggestCollectionName({
    credentialSubject: { achievement: [{ achievementType: 'Award' }] },
  })).toBe('Awards');
});

test('a collection id dashes whitespace, as new collections are created', () => {
  expect(collectionIdFor('Licenses and certifications')).toBe('Licenses-and-certifications');
  expect(collectionIdFor('  Degrees ')).toBe('Degrees');
});
