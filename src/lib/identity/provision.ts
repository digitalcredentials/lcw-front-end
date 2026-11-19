import { UNLOCK_SPACE_NAME, UNLOCK_SPACE_TYPE } from '@interop/wallet-core/keyring'
import { spaceUrlById } from '@interop/pws-client/paths/layout'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { UnlockCredential } from './credential'

// Space creation on this PWS server.
//
// The registration code is sent once, at signup, to create the account
// Space (`POST /spaces/`, where the server calls it the coupon). The Space
// it creates is the account as far as the server is concerned, and every
// other Space of the wallet (the client-annex Space, the unlock Space of
// each sign-in method) is created under it, at `POST /space/{account}/spaces`,
// with a capability on the account Space and no code. Nothing keeps the
// code after signup.
//
// The server creates a Space only for the did:key that signs the request
// and will control it. The account Space's controller is seldom that key,
// so whoever acts for the account delegates the capability to create one
// Space (POST only, on exactly that URL) to the new Space's key, which
// then invokes it. wallet-core's own Space step adopts the Space already
// in place.
//
// A server with open provisioning, such as the reference server, has no
// such route: there the ceremonies create each Space by id.
export type Provisioning = 'account' | 'open'

// How the account creates a further Space: the account Space it is created
// under, and the delegation of the creating capability to the did:key that
// will control the new Space.
export interface SpaceCreation {
  accountSpaceId: string
  grantTo: (controller: string) => Promise<IZcap>
}

// One request is made with a grant, at once. The lifetime only has to
// cover a device clock that runs behind the server's.
const CREATION_GRANT_TTL_MS = 15 * 60 * 1000

// A grant cannot outlast the capability it hangs from.
function grantExpiry(capability?: IZcap): Date {
  const wanted = Date.now() + CREATION_GRANT_TTL_MS
  // A root capability carries no expiry
  const parent = capability && 'expires' in capability && typeof capability.expires === 'string' ? Date.parse(capability.expires) : NaN
  return new Date(Number.isFinite(parent) ? Math.min(wanted, parent) : wanted)
}

// Where an account Space's further Spaces are created.
export const accountSpacesUrl = (serverUrl: string, accountSpaceId: string) => `${spaceUrlById({ baseServerUrl: serverUrl, spaceId: accountSpaceId })}spaces`

// Space creation under an account by whoever acts for it: `zcapClient`
// signs the grant, hanging it from `capability` when the signer's own
// authority over the account Space is itself delegated (a passphrase
// session's generation delegation), else from the account Space's root.
export function spaceCreationBy({
  zcapClient,
  serverUrl,
  accountSpaceId,
  capability,
}: {
  zcapClient: ZcapClient
  serverUrl: string
  accountSpaceId: string
  capability?: IZcap
}): SpaceCreation {
  return {
    accountSpaceId,
    grantTo: (controller) =>
      zcapClient.delegate({
        ...(capability && { capability }),
        invocationTarget: accountSpacesUrl(serverUrl, accountSpaceId),
        controller,
        allowedActions: ['POST'],
        expires: grantExpiry(capability),
      }),
  }
}

interface NewSpace {
  // The did:key that signs the request and will control the Space
  zcapClient: ZcapClient
  serverUrl: string
  id: string
  controller: string
  name: string
  type: string[]
}

// The server's answer to a registration code it does not accept: unknown,
// expired, or with no uses left.
const CODE_REFUSED = 'https://github.com/digitalcredentials/was-server-aws#coupon-required'

export class RegistrationCodeRefusedError extends Error {
  constructor() {
    // The sentence the back end answers its own check of the code with,
    // plus the cause only this server can be the source of: a code spends
    // one use per account, so one that worked before may have none left
    super("Your registration code isn't valid. You may have already used it. Please try again or obtain a new code.")
    this.name = 'RegistrationCodeRefusedError'
  }
}

// Creates the account Space by id with the registration code, signed as the
// did:key that will control it. This is the one request the code is sent
// to the server in.
export async function createAccountSpace({ zcapClient, serverUrl, registrationCode, id, controller, name, type }: NewSpace & { registrationCode: string }): Promise<void> {
  try {
    await zcapClient.request({ url: `${serverUrl}/spaces/`, method: 'POST', action: 'POST', json: { id, controller, name, type, coupon: registrationCode } })
  } catch (err) {
    if (statusOf(err) === 403 && problemTypeOf(err) === CODE_REFUSED) {
      throw new RegistrationCodeRefusedError()
    }
    throw err
  }
}

// Creates a Space by id under the account Space, signed as the did:key that
// will control it: with the grant delegated to that key, or with none when
// the key is the account Space's own controller.
export async function createSpaceUnderAccount({
  zcapClient,
  serverUrl,
  accountSpaceId,
  capability,
  id,
  controller,
  name,
  type,
}: NewSpace & { accountSpaceId: string; capability?: IZcap }): Promise<void> {
  await zcapClient.request({
    url: accountSpacesUrl(serverUrl, accountSpaceId),
    method: 'POST',
    action: 'POST',
    ...(capability && { capability }),
    json: { id, controller, name, type },
  })
}

// Creates a credential's unlock Space under the account, signed as the
// unlock identity that controls it, before the keyring's ensure adopts it.
// With no `creation` (open provisioning) the ensure creates the Space by
// id. A Space already there (a retry after a torn bind) is left as it is.
export async function provisionUnlockSpace({ credential, serverUrl, creation }: { credential: UnlockCredential; serverUrl: string; creation?: SpaceCreation }): Promise<void> {
  if (!creation) {
    return
  }
  const { unlock } = credential
  const controller = unlock.agent.id.split('#')[0]
  try {
    await createSpaceUnderAccount({
      zcapClient: unlock.zcapClient,
      serverUrl,
      accountSpaceId: creation.accountSpaceId,
      capability: await creation.grantTo(controller),
      id: unlock.spaceId,
      controller,
      name: UNLOCK_SPACE_NAME,
      type: [...UNLOCK_SPACE_TYPE],
    })
  } catch (err) {
    if (statusOf(err) !== 409) {
      throw err
    }
  }
}

function problemTypeOf(err: unknown): string | undefined {
  const { data, response } = (err ?? {}) as { data?: { type?: unknown }; response?: { data?: { type?: unknown } } }
  const found = data?.type ?? response?.data?.type
  return typeof found === 'string' ? found : undefined
}

function statusOf(err: unknown): number | undefined {
  const { status, response } = (err ?? {}) as { status?: unknown; response?: { status?: unknown } }
  const found = typeof status === 'number' ? status : response?.status
  return typeof found === 'number' ? found : undefined
}
