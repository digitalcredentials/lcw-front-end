import type { ResourceData } from '@interop/pws-client'
import { createEdvDocCipher, resolveHmacKey } from '@interop/pws-client/edv'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { deriveNextKeyHash } from '@interop/did-method-webvh'
import {
  cascadeCompletion,
  currentAccountSigningKeys,
  disconnectEligibility,
  listAccountClients,
  revokeAccountClient,
  revokedClientKeysFor,
  type AccountClientView,
  type DisconnectRefusal,
} from '@interop/wallet-core/clients'
import { normalizeDisplayName, pwsConnectionsStore, readConnections, retireConnection, setConnectionLabel, type ConnectionIdKey, type ConnectionsStore } from '@interop/wallet-core/connections'
import { approveEnrollment, enrollmentClientDid, isConnectCode, parseEnrollmentRequest, type EnrollmentRequest } from '@interop/wallet-core/enrollment'
import { CONNECTIONS_COLLECTION, WALLET_ACTIVITY_COLLECTION, addHistoryClientConnected, addHistoryClientRevoked } from '@interop/wallet-core/space'
import { clientSigningKeyMultibase, ensureDidWebProjection, walletClientDid } from '@interop/wallet-core/webvh'
import { adoptUserKey, ceremonyAuthority, renewGenerationDelegation, type CeremonyAuthority } from './authority'
import { readRegistry } from './registry'
import { sessionSpaceUrl, sessionVaultKeys, type RememberedSession, type Session } from './session'
import type { UnlockMethodsRecord } from './unlockMethods'
import { visitPins } from './pins'

// The wallets connected to the account: every enrolled client the account
// document lists (a browser this wallet remembers under a passkey, a
// FreeWallet installation, any other wallet-core client), named from the
// account's connections directory. Connecting another wallet is approving
// the connect code it shows (wallet-core's enrollment: the user key is
// escrowed to the new client and its keys are published in the account
// document); disconnecting one is wallet-core's revocation cascade: its keys
// leave the document, the user key is rotated, and every encrypted
// collection takes an epoch under the new key.

// The name this wallet gives its own clients in the directory
export const CLIENT_NAME = 'Learner Credential Wallet'

export interface ConnectedWallet {
  signingKeyMultibase: string
  // The client's did:key, its id in the connections directory
  did: string
  // Its self-declared or suggested name, and the holder's own name for it
  name?: string
  label?: string
  displayName: string
  addedAt?: string
  // This browser's own client (a remembered session)
  isCurrent: boolean
  canDisconnect: boolean
  refusal?: DisconnectRefusal
  // The row as wallet-core lists it, what the disconnect ceremony takes
  view: AccountClientView
}

export interface DisconnectOutcome {
  // `partial` when a collection could not take its epoch; the next
  // disconnect or sign-in method removal resumes it
  completion: 'complete' | 'partial'
  rotated: boolean
}

const signerKind = (session: Session) => (session.kind === 'remembered' ? 'client' : 'ladder')

const actor = (session: Session) => ({ email: session.email })

async function ownSigningKey(session: Session): Promise<string | undefined> {
  if (session.kind !== 'remembered') {
    return undefined
  }
  const { keyAgent } = await agentsFromSeed({ seed: session.clientSeed })
  return clientSigningKeyMultibase({ keyAgent })
}

// The connections directory: an encrypted collection whose entries are
// keyed by its blinding key. Built from the session as it stands now.
async function directory(authority: CeremonyAuthority): Promise<{ store: ConnectionsStore; hmacKey: ConnectionIdKey }> {
  const space = await authority.spaceHandle()
  const collection = space.collection(CONNECTIONS_COLLECTION)
  const described = await collection.describe()
  const encryption = described?.encryption
  if (!encryption) {
    throw new Error('The account has no connections directory.')
  }
  const { keyAgreementKey, keyResolver } = sessionVaultKeys(authority.session)
  const hmacKey = await resolveHmacKey({ encryption, keyAgreementKey, required: true })
  if (!hmacKey) {
    throw new Error('The connections directory has no blinding key.')
  }
  const cipher = await createEdvDocCipher({ keyAgreementKey, keyResolver, collectionId: CONNECTIONS_COLLECTION, encryption })
  return { store: pwsConnectionsStore({ collection, cipher }), hmacKey }
}

// Writes an activity row. Best effort: the log records what happened and
// is never a condition for it.
async function recordActivity(authority: CeremonyAuthority, entry: object): Promise<void> {
  try {
    const space = await authority.spaceHandle()
    await space.collection(WALLET_ACTIVITY_COLLECTION).add(entry as unknown as ResourceData)
  } catch (err) {
    console.warn('The activity entry could not be written:', err)
  }
}

async function setWalletName({ authority, did, name, label }: { authority: CeremonyAuthority; did: string; name?: string; label?: string }): Promise<void> {
  const { store, hmacKey } = await directory(authority)
  const enrolledSigningKeys = await currentAccountSigningKeys({ did: authority.session.did, accountLogPinStore: visitPins })
  await setConnectionLabel({ store, hmacKey, did, kind: 'wallet-client', ...(name !== undefined && { name }), ...(label !== undefined && { label }), enrolledSigningKeys })
}

export function refusalMessage(refusal: DisconnectRefusal | undefined): string {
  switch (refusal) {
    case 'self':
      return 'This browser cannot disconnect itself. Forget this browser under Sign-in credentials, or disconnect it from another wallet.'
    case 'last-client':
      return 'The last connected wallet cannot disconnect itself.'
    case 'unattributed-update-key':
      return "This wallet's update key could not be attributed from the account log, so it cannot be disconnected from here."
    default:
      return 'This wallet cannot be disconnected from here.'
  }
}

export async function listConnectedWallets(session: Session): Promise<ConnectedWallet[]> {
  const authority = await ceremonyAuthority(session)
  const verified = await authority.verified()
  const readDirectoryEntries = async () => {
    try {
      const { store, hmacKey } = await directory(authority)
      return (await readConnections({ store, hmacKey }))?.entries.map((entry) => entry.entry) ?? []
    } catch (err) {
      console.warn('The connections directory could not be read; the wallets are listed unnamed:', err)
      return []
    }
  }
  const ownSigningKeyMultibase = await ownSigningKey(session)
  const clients = await listAccountClients({ did: session.did, verifiedLog: verified, readDirectoryEntries, ...(ownSigningKeyMultibase && { ownSigningKeyMultibase }) })
  return clients.map((view) => {
    const { allowed, refusal } = disconnectEligibility({ client: view, clients, signerKind: signerKind(session) })
    return {
      signingKeyMultibase: view.signingKeyMultibase,
      did: walletClientDid({ signingKeyMultibase: view.signingKeyMultibase }),
      ...(view.name !== undefined && { name: view.name }),
      ...(view.label !== undefined && { label: view.label }),
      displayName: view.label || view.name || 'Unnamed wallet',
      ...(view.addedAt !== undefined && { addedAt: view.addedAt }),
      isCurrent: view.isCurrent,
      canDisconnect: allowed,
      ...(refusal !== undefined && { refusal }),
      view,
    }
  })
}

// Whether text is a connect code, and the client identity a code names (for
// the holder to compare with the fingerprint the other wallet shows).
export { isConnectCode }

export function inspectConnectCode(code: string): { request: EnrollmentRequest; clientDid: string } {
  const request = parseEnrollmentRequest({ code })
  return { request, clientDid: enrollmentClientDid({ request }) }
}

// Approves a connect code: the new client is enrolled, named in the
// directory (`name` is the suggested name, `label` the holder's own when
// they changed it), and the connection recorded in the activity log.
export async function approveConnectCode({
  session,
  code,
  name,
  label,
}: {
  session: Session
  code: string
  name: string
  label?: string
}): Promise<{ clientDid: string; signingKeyMultibase: string }> {
  const request = parseEnrollmentRequest({ code })
  const authority = await ceremonyAuthority(session)
  const { clientDid, signingKeyMultibase } = await approveEnrollment({
    request,
    signer: authority.signer,
    clientKeyAgreementKey: authority.clientKeyAgreementKey,
    userKeyRosterStore: authority.rosterStore(),
    idStore: authority.idStore,
  })
  authority.invalidate()
  if (session.kind === 'transient') {
    // The ladder arm leaves the did:web projection to the next writer
    await republishProjection(authority).catch((err) => console.warn('The did:web projection could not be republished:', err))
  }
  const normalizedLabel = label !== undefined ? normalizeDisplayName({ value: label }) : undefined
  await setWalletName({ authority, did: clientDid, name, ...(normalizedLabel && normalizedLabel !== name && { label: normalizedLabel }) }).catch((err) =>
    console.warn('The connected wallet could not be named:', err)
  )
  await recordActivity(authority, addHistoryClientConnected({ user: actor(session), signingKeyMultibase, clientDid, label: normalizedLabel ?? name }))
  return { clientDid, signingKeyMultibase }
}

async function republishProjection(authority: CeremonyAuthority): Promise<void> {
  const verified = await authority.verified()
  await ensureDidWebProjection({ store: authority.projectionStore, did: authority.session.did, doc: verified.doc })
}

export async function renameConnectedWallet({ session, signingKeyMultibase, label }: { session: Session; signingKeyMultibase: string; label: string }): Promise<void> {
  const authority = await ceremonyAuthority(session)
  await setWalletName({ authority, did: walletClientDid({ signingKeyMultibase }), label })
}

// Names this browser's own client in the directory, after it enrolled.
export async function nameOwnClient(session: RememberedSession): Promise<void> {
  const signingKeyMultibase = await ownSigningKey(session)
  if (!signingKeyMultibase) {
    return
  }
  const authority = await ceremonyAuthority(session)
  await setWalletName({ authority, did: walletClientDid({ signingKeyMultibase }), name: CLIENT_NAME })
}

// The standing credentials' committed rung hashes, which the revocation
// tells apart from the disconnected client's own commitments
async function latentHashesOf(registry: UnlockMethodsRecord | null): Promise<string[]> {
  const keys = new Set<string>()
  for (const method of registry?.methods ?? []) {
    const key = (method as { updateKeyMultibase?: unknown }).updateKeyMultibase
    if (typeof key === 'string' && key) {
      keys.add(key)
    }
  }
  return Promise.all([...keys].map((key) => deriveNextKeyHash(key)))
}

// Disconnects a wallet: its keys leave the account document, the user key
// is rotated and every encrypted collection takes an epoch under the new
// key (this session adopts it as it goes), its directory entry is retired
// and the disconnection recorded. What the wallet already fetched stays
// readable to it; nothing written from now on is.
export async function disconnectWallet({ session, wallet }: { session: Session; wallet: ConnectedWallet }): Promise<DisconnectOutcome> {
  if (!wallet.canDisconnect) {
    throw new Error(refusalMessage(wallet.refusal))
  }
  const revokedClient = revokedClientKeysFor({ client: wallet.view })
  // The generation delegation first, in case this client signed it: a
  // transient session would otherwise lose its own authority with the
  // client's keys
  const renewed = await renewGenerationDelegation({ session, retiringKeyMultibases: [wallet.signingKeyMultibase] })
  const authority = await ceremonyAuthority(renewed.session)
  const registry = await readRegistry(authority.session)
  const result = await revokeAccountClient({
    idStore: authority.idStore,
    signer: authority.signer,
    projectionStore: authority.projectionStore,
    revokedClient,
    knownLatentHashes: await latentHashesOf(registry),
    expectedDid: session.did,
    rosterStore: authority.rosterStore(),
    userKey: authority.session.userKey,
    clientKeyAgreementKey: authority.clientKeyAgreementKey,
    onUserKeyAdopted: async ({ userKey }) => adoptUserKey({ authority, userKey }),
    collections: authority.collections,
  })
  authority.invalidate()
  try {
    const { store, hmacKey } = await directory(authority)
    await retireConnection({ store, hmacKey, did: wallet.did, handledZcapIds: [], spaceUrl: sessionSpaceUrl(authority.session) })
  } catch (err) {
    console.warn("The disconnected wallet's directory entry could not be retired:", err)
  }
  const rotated = Object.values(result.collections.outcomes).filter((outcome) => outcome === 'rotated').length
  await recordActivity(
    authority,
    addHistoryClientRevoked({ user: actor(session), signingKeyMultibase: wallet.signingKeyMultibase, label: wallet.displayName, rotated, failed: result.collections.failed.length })
  )
  return { completion: cascadeCompletion({ collections: result.collections, rosterSeal: result.rosterSeal }), rotated: result.rotated }
}
