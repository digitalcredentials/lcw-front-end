import { PwsClient } from '@interop/pws-client'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { ladderVmAgent, ladderVmZcapClient } from '@interop/wallet-core/clientAnnex'
import { RECOVERY_KDF, delegateLogWrite, generateRecoveryCode, normalizeRecoveryCode, publishRecoveryKey, recordedDelegationFields, recoveryClientFromCode } from '@interop/wallet-core/recovery'
import { deriveUnlockIdentity, ensureUnlockSpace, putUnlockKeyring } from '@interop/wallet-core/keyring'
import { wrapUnlockRecord } from '@interop/wallet-core/unlock'
import { accountControllerResolver, pwsWebvhIdStore, webvhZcapClient } from '@interop/wallet-core/webvh'
import { addUserKeyRosterRecipient, userKeyRosterDescriptorStore, userKeyRosterLogSigner } from '@interop/wallet-core/keys'
import type { UnlockCredential } from './credential'
import { provisionUnlockSpace } from './provision'
import { delegateUnlockManagement, fetchStandingRecord, pointerOf, type StandingRecord } from './records'
import type { Session, RememberedSession, TransientSession } from './session'
import { actingAuthority } from './standing'
import { serviceDescriptionFor } from './service'
import { visitPins } from './pins'
import { openTransientSession, type TransientEntry } from './transient'
import type { RecoveryCodeUnlockMethod } from './unlockMethods'

// Recovery codes, FreeWallet's way with this wallet's custody (decision 2):
// a code is a standing credential of the account (its own unlock Space and
// record, its key-agreement key in the roster, its ladder VM in the account
// document), issued from a signed-in session and then handed to the back
// end, which emails it to the account's address on request. Entering a
// code is a transient login on that credential, after which the wallet
// sets a new passphrase and issues a fresh code.

export interface RecoveryClientCredential extends UnlockCredential {
  client: Awaited<ReturnType<typeof recoveryClientFromCode>>
}

// The credential a code expands to: the code-derived unlock identity and
// the recovery client as its standing client.
export async function recoveryCredential(input: string): Promise<RecoveryClientCredential> {
  const code = normalizeRecoveryCode({ input })
  const client = await recoveryClientFromCode({ code })
  const unlock = await deriveUnlockIdentity({ secret: client.codeBytes, kdf: RECOVERY_KDF })
  return { unlock, standing: client, client }
}

export interface IssuedRecoveryCode {
  code: string
  entry: RecoveryCodeUnlockMethod
}

// Issues a new recovery code for the account from a live session. The
// code's unlock Space is created with the coupon (the session's
// registration token unless given), so the server's capped coupon-less
// path is not used.
export async function issueRecoveryCode({ session, label = 'Recovery code', coupon = session.coupon }: { session: Session; label?: string; coupon?: string }): Promise<IssuedRecoveryCode> {
  const code = generateRecoveryCode()
  const credential = await recoveryCredential(code)
  const { client, unlock } = credential
  const serverUrl = session.serverUrl
  const serviceDescription = await serviceDescriptionFor(serverUrl)
  const pointer = pointerOf({ serverUrl, spaceId: session.spaceId, did: session.did })

  // 1. The bridge and the record, before any entry. The bridge's delegatee
  // is the code's own signing did:key; its signer is the code's own ladder
  // VM, which the authority entry below publishes
  const delegation = await delegateLogWrite({ zcapClient: await ladderVmZcapClient({ accountDid: session.did, ladderSeed: client.ladderSeed }), pointer, recoveryClientDid: client.clientDid })
  const codeLadderAgent = await ladderVmAgent({ ladderSeed: client.ladderSeed })
  const record = await wrapUnlockRecord({
    controller: codeLadderAgent.id.split('#')[0],
    email: session.email,
    pointer,
    delegation,
    keyAgreementKey: unlock.keyAgreementKey,
    signer: unlock.recordSigner,
    bindingMacKey: client.bindingMacKey,
  })
  await provisionUnlockSpace({ credential, serverUrl, coupon })
  await ensureUnlockSpace({ baseServerUrl: serverUrl, zcapClient: unlock.zcapClient, serviceDescription, spaceId: unlock.spaceId, controller: unlock.agent.id })
  await putUnlockKeyring({ baseServerUrl: serverUrl, zcapClient: unlock.zcapClient, serviceDescription, spaceId: unlock.spaceId, record })
  const manageCapability = await delegateUnlockManagement({ credential, serverUrl, to: session.did })

  const recovery = { keyAgreementKeyMultibase: client.keyAgreementKeyMultibase, updateKeyMultibase: client.updateKeyMultibase }
  const recipient = { id: client.recipientKid, publicKeyMultibase: client.keyAgreementKeyMultibase }

  if (session.kind === 'transient') {
    // The ladder branch: the key entry, the escrow (licensed by that
    // entry), then the authority entry
    const acting = await actingAuthority(session)
    const publish = (part: 'key' | 'authority') =>
      publishRecoveryKey({ idStore: acting.idStore(), signer: { kind: 'ladder', ladderSeed: session.ladderSeed }, recovery, ladderSeed: client.ladderSeed, part, expectedDid: session.did })
    await publish('key')
    await addUserKeyRosterRecipient({ store: acting.rosterStore(), recipient, ownerKeyAgreementKey: acting.standingAgents.keyAgreementKey })
    await publish('authority')
  } else {
    // The enrolled branch: the escrow, then one entry
    const enrolled = await enrolledAuthority(session)
    await addUserKeyRosterRecipient({ store: enrolled.rosterStore(), recipient, ownerKeyAgreementKey: enrolled.agents.keyAgreementKey })
    await publishRecoveryKey({ idStore: enrolled.idStore(), signer: { kind: 'enrolled', updateKeys: session.webvhUpdateKeys }, recovery, ladderSeed: client.ladderSeed, part: 'all', expectedDid: session.did })
  }

  const entry: RecoveryCodeUnlockMethod = {
    type: 'recovery-code',
    label,
    createdAt: new Date().toISOString(),
    unlockSpaceId: unlock.spaceId,
    manageCapability,
    recoveryKid: client.recipientKid,
    keyAgreementKeyMultibase: client.keyAgreementKeyMultibase,
    updateKeyMultibase: client.updateKeyMultibase,
    ...recordedDelegationFields({ delegation }),
    recoveryClientDid: client.clientDid,
    unlockKeyAgreementKeyId: unlock.keyAgreementKey.id,
    unlockKeyAgreementKeyMultibase: unlock.keyAgreementKey.publicKeyMultibase,
  }
  return { code, entry }
}

// A remembered session's authority over the account log and the roster:
// the enrolled client's own key, signing as the account.
export async function enrolledAuthority(session: RememberedSession) {
  const serviceDescription = await serviceDescriptionFor(session.serverUrl)
  const agents = await agentsFromSeed({ seed: session.clientSeed })
  const zcapClient = webvhZcapClient({ keyAgent: agents.keyAgent, did: session.did })
  const pws = new PwsClient({ baseServerUrl: session.serverUrl, zcapClient, serviceDescription })
  return {
    serviceDescription,
    agents,
    zcapClient,
    pws,
    idStore: () => pwsWebvhIdStore({ pws, spaceId: session.spaceId, pinStore: visitPins }),
    rosterStore: () =>
      userKeyRosterDescriptorStore({
        baseServerUrl: session.serverUrl,
        zcapClient,
        spaceId: session.spaceId,
        serviceDescription,
        resolveController: accountControllerResolver({ did: session.did, pinStore: visitPins }),
        pinStore: visitPins,
        signer: userKeyRosterLogSigner({ keyAgent: agents.keyAgent }),
      }),
  }
}

// Enters the account with a recovery code: a transient session on the
// code's credential. Null when no account is bound to the code.
export async function recoverWithCode({ code, serverUrl }: { code: string; serverUrl: string }): Promise<(TransientEntry & { found: StandingRecord; credential: RecoveryClientCredential }) | null> {
  const credential = await recoveryCredential(code)
  const found = await fetchStandingRecord({ credential, serverUrl })
  if (!found) {
    return null
  }
  // The code's ladder seed derives from the code, so its record carries none
  const standing = { ...found, ladderSeed: found.ladderSeed ?? credential.client.ladderSeed }
  const entry = await openTransientSession({ credential, found: standing, serverUrl })
  return { ...entry, found: standing, credential }
}

export type { TransientSession }
