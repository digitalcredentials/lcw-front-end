import { discoverService, type ServiceDescription } from '@interop/was-client'

// The PWS server's service description, discovered once per server: a
// client reads it before its first signed request, and a sign-in builds
// several clients (the unlock identity's, the account's, one per record),
// so each would otherwise repeat the discovery round trip.
const descriptions = new Map<string, Promise<ServiceDescription>>()

export function serviceDescriptionFor(serverUrl: string): Promise<ServiceDescription> {
  const key = serverUrl.replace(/\/+$/, '')
  let pending = descriptions.get(key)
  if (!pending) {
    pending = discoverService({ url: key }).then((info) => info.description)
    pending.catch(() => descriptions.delete(key))
    descriptions.set(key, pending)
  }
  return pending
}
