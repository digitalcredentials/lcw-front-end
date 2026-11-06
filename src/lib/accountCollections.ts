// Collections of the Main Space that hold the account itself rather than
// the user's credentials: `id`, the did:webvh log and its did:web
// projection, and `account`, the credential catalogue and the user-key
// roster (src/lib/identity). The wallet writes them; the space browser and
// the pickers leave them out.
export const ACCOUNT_COLLECTIONS = ['id', 'account'] as const

export function isAccountCollection(id: string): boolean {
  return (ACCOUNT_COLLECTIONS as readonly string[]).includes(id)
}
