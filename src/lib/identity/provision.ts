import { UNLOCK_SPACE_NAME, UNLOCK_SPACE_TYPE } from '@interop/wallet-core/keyring'
import type { ZcapClient } from '@interop/ezcap'
import type { UnlockCredential } from './credential'

// Space creation with this server's coupon. The PWS server counts the
// Spaces made without a coupon (a create-by-id under a key the caller
// holds) against a global cap, so this wallet creates every Space it
// needs, the unlock Spaces of its credentials included, through
// `POST /spaces/` with the coupon: the registration code at signup, the
// registration token `/login` returns afterwards. wallet-core's own Space
// step then adopts the Space already in place.

// Creates a Space by id with the coupon (`POST /spaces/`, this server's
// extension), signed as the did:key that will control it.
export async function createSpaceWithCoupon({
  zcapClient,
  serverUrl,
  coupon,
  id,
  controller,
  name,
  type,
}: {
  zcapClient: ZcapClient
  serverUrl: string
  coupon: string
  id: string
  controller: string
  name: string
  type: string[]
}): Promise<void> {
  await zcapClient.request({ url: `${serverUrl}/spaces/`, method: 'POST', action: 'POST', json: { id, controller, name, type, coupon } })
}

// Creates a credential's unlock Space with the coupon when one is at hand,
// signed as the unlock identity that controls it, before the keyring's
// ensure adopts it. Without a coupon the ensure creates the Space by id (a
// server with open provisioning, or the derived path this server caps). A
// Space already there (a retry after a torn bind) is left as it is.
export async function provisionUnlockSpace({ credential, serverUrl, coupon }: { credential: UnlockCredential; serverUrl: string; coupon?: string }): Promise<void> {
  if (!coupon) {
    return
  }
  const { unlock } = credential
  try {
    await createSpaceWithCoupon({
      zcapClient: unlock.zcapClient,
      serverUrl,
      coupon,
      id: unlock.spaceId,
      controller: unlock.agent.id.split('#')[0],
      name: UNLOCK_SPACE_NAME,
      type: [...UNLOCK_SPACE_TYPE],
    })
  } catch (err) {
    if (statusOf(err) !== 409) {
      throw err
    }
  }
}

function statusOf(err: unknown): number | undefined {
  const { status, response } = (err ?? {}) as { status?: unknown; response?: { status?: unknown } }
  const found = typeof status === 'number' ? status : response?.status
  return typeof found === 'number' ? found : undefined
}
