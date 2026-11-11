// Collections of the account Space that hold the account itself rather
// than the user's credentials: wallet-core's `id` (the did:webvh log and its
// did:web projection), `key-map` (the user-key roster), `unlock-methods`
// (the sign-in methods registry), `connections`, `inbox` and `app-keys`,
// plus `account`, the previous wallet's catalogue. The space browser and
// the pickers leave them out.
//
// The ids are spelled out rather than imported from
// `@interop/wallet-core/space` (ID_COLLECTION.id, KEY_MAP_COLLECTION.id,
// UNLOCK_METHODS_COLLECTION.id, CONNECTIONS_COLLECTION, INBOX_COLLECTION,
// APP_KEYS_COLLECTION): that module's import chain does not load under
// Playwright's Node-side runner, which the data export's unit spec uses.
export const ACCOUNT_COLLECTIONS = ['id', 'key-map', 'unlock-methods', 'connections', 'inbox', 'app-keys', 'account'] as const

export function isAccountCollection(id: string): boolean {
  return (ACCOUNT_COLLECTIONS as readonly string[]).includes(id)
}
