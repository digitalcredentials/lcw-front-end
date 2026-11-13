// Tags as the holder typed them, trimmed, without blanks or repeats. On its
// own so the modules that run outside the browser (the data import's
// reader, under the test runner) take it without the credential store's
// dependencies.
export function normalizeTags(tags: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}
