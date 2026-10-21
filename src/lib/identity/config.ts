import type { IdentityConfig } from './index'

// The identity layer's configuration from the wallet's environment. Kept
// out of the identity modules themselves so they run unchanged under Node
// (the test scripts pass their own configuration).
export function identityConfig(): IdentityConfig {
  const trim = (value: string | undefined) => (value ?? '').replace(/\/+$/, '')
  return {
    apiBase: trim(import.meta.env.VITE_API_BASE_URL),
    serverUrl: trim(import.meta.env.VITE_WAS_BASE_URL),
    idDomain: import.meta.env.VITE_ID_DOMAIN ?? '',
  }
}
