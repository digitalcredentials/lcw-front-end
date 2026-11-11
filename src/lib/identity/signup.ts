import { PwsClient } from '@interop/pws-client'
import {
  CLIENT_ANNEX_SPACE_TYPE,
  assertHostClaimsClientAnnexProfile,
  establishCredentialAnchoredAccount,
  ladderVmAgent,
  mintDelegatedClientsDelegation,
  type CredentialAnchoredEstablishment,
} from '@interop/wallet-core/clientAnnex'
import { mintSpaceId } from '@interop/wallet-core/genesis'
import { generateLadderSeed } from '@interop/wallet-core/unlock'
import { accountControllerResolver, didKeyZcapClient, pwsWebvhIdStore } from '@interop/wallet-core/webvh'
import { accountCollectionStores, userKeyRosterDescriptorStore, userKeyRosterLogSigner } from '@interop/wallet-core/keys'
import { WALLET_SPACE_NAME } from '@interop/wallet-core/space'
import { memoryResourceLogPinStore } from '@interop/vh-resource-log'
import type { ZcapClient } from '@interop/ezcap'
import { passphraseCredential, type UnlockCredential } from './credential'
import { bindStandingRecord, fetchStandingRecord, pointerOf } from './records'
import { emptyRegistry, standingFieldsOf, updateUnlockMethods, upsertPassphraseMethod } from './unlockMethods'
import { serviceDescriptionFor } from './service'

// Registration: the credential-anchored account genesis, FreeWallet's
// signup, wrapped in this wallet's coupon and email registration.
//
// The passphrase is the anchoring credential. Its standing record is
// written first (the ladder seed must be recoverable before anything
// derived from it is published), then wallet-core's establishment runs:
// the account Space and the client-annex Space, the did:webvh genesis, the
// user-key roster with the passphrase as its first recipient, epoch zero on
// every encrypted collection, the annex generation, the record re-bind
// with the account DID, and the controller promotion. Before that promotion
// (the last window where the bootstrap did:key still controls the Space)
// the passphrase is recorded in the unlock-methods registry and the email
// is registered with the back end.
//
// The two Spaces are created here with the coupon, under the bootstrap
// did:key the ceremony then finds in control, so the server's coupon-less
// paths and their cap are never used: the ceremony's Space steps are
// ensures that adopt a Space already in place.

export interface SignupConfig {
  // lcw-back-end, which registers the email; absent, no email is registered
  // (a test against a bare PWS server)
  apiBase?: string
  serverUrl: string
  // How the two Spaces come to exist: created here with the registration
  // code as the coupon (this server), or left to the ceremony's create-by-id
  // (a server with open provisioning, such as the reference server)
  provisioning?: 'coupon' | 'open'
}

export const ANNEX_SPACE_NAME = 'Client annex'

interface ErrorBody {
  message?: string
  error?: string
}

// Creates a Space by id with the coupon (`POST /spaces/`, this server's
// extension), signed as the did:key that will control it.
async function createSpaceWithCoupon({
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

export class AccountExistsError extends Error {
  constructor() {
    super('An account already uses this passphrase. Sign in instead, or choose another passphrase.')
    this.name = 'AccountExistsError'
  }
}

export interface SignupResult {
  credential: UnlockCredential
  establishment: CredentialAnchoredEstablishment
  message: string
}

export async function signUp({
  email,
  passphrase,
  registrationCode,
  config,
  onStage,
}: {
  email: string
  passphrase: string
  registrationCode: string
  config: SignupConfig
  onStage?: (stage: string) => void
}): Promise<SignupResult> {
  const { serverUrl } = config
  const serviceDescription = await serviceDescriptionFor(serverUrl)
  // Every signup publishes a ladder verification method, whose delegations
  // only a server enforcing the client-annex clause bounds
  assertHostClaimsClientAnnexProfile({ serviceDescription })

  onStage?.('Deriving your passphrase key')
  const credential = await passphraseCredential(passphrase)
  if (await fetchStandingRecord({ credential, serverUrl })) {
    throw new AccountExistsError()
  }

  // The bootstrap identity: the ladder VM's bare did:key, which controls
  // both Spaces until the promotion
  const ladderSeed = generateLadderSeed()
  const bootstrapAgent = await ladderVmAgent({ ladderSeed })
  const bootstrapZcap = didKeyZcapClient({ keyAgent: bootstrapAgent })
  const bootstrapDid = bootstrapAgent.id.split('#')[0]
  const spaceId = mintSpaceId()
  const annexSpaceId = mintSpaceId()

  if ((config.provisioning ?? 'coupon') === 'coupon') {
    onStage?.('Creating your storage space')
    await createSpaceWithCoupon({ zcapClient: bootstrapZcap, serverUrl, coupon: registrationCode, id: spaceId, controller: bootstrapDid, name: WALLET_SPACE_NAME, type: ['Space'] })
    await createSpaceWithCoupon({ zcapClient: bootstrapZcap, serverUrl, coupon: registrationCode, id: annexSpaceId, controller: bootstrapDid, name: ANNEX_SPACE_NAME, type: [...CLIENT_ANNEX_SPACE_TYPE] })
  }

  // The sibling delegation into the annex Space, which names the Space the
  // ceremony then adopts rather than minting one
  const sibling = await mintDelegatedClientsDelegation({ zcapClient: bootstrapZcap, baseServerUrl: serverUrl, clientAnnexSpaceId: annexSpaceId, controller: credential.standing.clientDid })

  const pins = memoryResourceLogPinStore()
  const pointer = pointerOf({ serverUrl, spaceId })
  const bootstrapPws = new PwsClient({ baseServerUrl: serverUrl, zcapClient: bootstrapZcap, serviceDescription })
  const idStore = pwsWebvhIdStore({ pws: bootstrapPws, spaceId, pinStore: pins })
  let message = ''

  onStage?.('Publishing your identity')
  const establishment = await establishCredentialAnchoredAccount({
    baseServerUrl: serverUrl,
    spaceId,
    ladderSeed,
    standing: {
      clientDid: credential.standing.clientDid,
      keyAgreementKeyMultibase: credential.standing.keyAgreementKeyMultibase,
      recipientKid: credential.standing.recipientKid,
      keyAgreementKey: credential.standing.agents.keyAgreementKey,
    },
    bindRecord: (bind) => bindStandingRecord({ credential, serverUrl, email, ladderSeed, ...bind }),
    rosterStoreFor: ({ did, log }) =>
      userKeyRosterDescriptorStore({
        baseServerUrl: serverUrl,
        zcapClient: bootstrapZcap,
        spaceId,
        resolveController: accountControllerResolver({ did, pinStore: pins, log }),
        pinStore: pins,
        signer: userKeyRosterLogSigner({ keyAgent: bootstrapAgent }),
        serviceDescription,
      }),
    collectionStoreFor: ({ did, log }) =>
      accountCollectionStores({ baseServerUrl: serverUrl, zcapClient: bootstrapZcap, spaceId, did, pinStore: pins, signer: userKeyRosterLogSigner({ keyAgent: bootstrapAgent }), serviceDescription, log }),
    bootstrapPwsFor: ({ keyAgent }) => new PwsClient({ baseServerUrl: serverUrl, zcapClient: didKeyZcapClient({ keyAgent }), serviceDescription }),
    idStore,
    lowEntropy: true,
    delegatedClients: sibling,
    beforePromotion: async ({ pws, userKey, did, establishment: partial }) => {
      onStage?.('Registering the account')
      // The registry entry for the passphrase, in the last root-invocation
      // window under the bootstrap did:key
      await updateUnlockMethods({
        pws,
        spaceId,
        userKey,
        mutate: (existing) =>
          upsertPassphraseMethod({
            record: existing ?? emptyRegistry(),
            unlockSpaceId: partial.unlockSpaceId,
            manageCapability: partial.manageCapability,
            standing: standingFieldsOf(partial.standingFields),
          }),
      })
      // The email, with the back end
      if (config.apiBase) {
        const res = await fetch(`${config.apiBase}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, did, registrationCode }),
        })
        const body = (await res.json().catch(() => ({}))) as ErrorBody
        if (!res.ok) {
          throw new Error(body.error ?? 'Unable to register. Please try again.')
        }
        message = body.message ?? 'Registration started. Check your email for a confirmation link.'
      }
    },
    onStage: (stage) => onStage?.(`Setting up your account (${stage})`),
  })
  if (establishment.did !== pointer.did && pointer.did !== undefined) {
    throw new Error('The establishment published a different account than the pointer names.')
  }
  return { credential, establishment, message }
}
