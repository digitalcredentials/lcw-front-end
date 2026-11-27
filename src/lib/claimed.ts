// What an issuer's exchange hands the wallet: the credentials in the
// presentation it answers with. An issuer may issue several in one exchange
// (a college's certificate and licence together), all to the one DID the
// wallet proved, so the wallet saves every one of them.

// Every credential in an exchange's answer, in the issuer's order. The
// presentation's `verifiableCredential` is one credential or a list.
export function claimedCredentials(envelope: unknown): Record<string, unknown>[] {
  const held = (envelope as { verifiableCredential?: unknown } | null | undefined)?.verifiableCredential;
  const listed: unknown[] = [held ?? []].flat();
  return listed.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );
}

// Saves the credentials one after another, recording each one's position in
// `saved` as it is stored. A save that fails throws and leaves the rest
// unsaved; calling again with the same `saved` stores only what is missing,
// so pressing Save again never stores a credential twice.
export async function saveClaimed({
  credentials,
  saved,
  save,
}: {
  credentials: Record<string, unknown>[];
  saved: Set<number>;
  save: (credential: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  for (const [index, credential] of credentials.entries()) {
    if (saved.has(index)) {
      continue;
    }
    await save(credential);
    saved.add(index);
  }
}

// The one tag to suggest for everything received: the suggestion they
// share, or none when they differ (the holder tags them in the wallet).
export function sharedSuggestion(suggestions: string[]): string {
  return suggestions.length > 0 && suggestions.every((suggestion) => suggestion === suggestions[0]) ? suggestions[0] : '';
}

// "A", "A and B", "A, B and C"
export function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
