// An account the tests make for themselves. It is registered the way the
// register page registers one, its email is confirmed without a person,
// it is seeded with the badge the tests look for, and it is deleted when
// the tests are done: its Spaces on the PWS server and its rows on the back
// end. No account is kept between runs, so nothing grows from one run to
// the next (the account's logs, its sign-in methods' Spaces).
//
// Two steps need AWS access to the deployment (the `aws` CLI, signed in to
// the account that hosts it):
//
//   - the email confirmation: the link is read from the registration state
//     machine's pending execution and opened, as the person reading the
//     email would open it;
//   - the back end's two rows for the account (the accounts table and the
//     recovery table), which no endpoint deletes.
//
// Everything else goes through the PWS server and the back end as the
// wallet itself uses them. The address is an Amazon SES mailbox-simulator
// one: SES accepts the registration's messages and delivers them to nobody.
//
// A run records its account in tests/.test-account.<name>.json until it has
// deleted it, so an account left by a run that was cut short is deleted by
// the next run under the same name.
//
// Environment: REGISTRATION_CODE (required to create), API_BASE and WAS_URL
// (default to the sandbox), BACK_END_STACK (the back end's CloudFormation
// stack, default lcw-back-end), ACCOUNTS_TABLE, RECOVERY_TABLE and
// SPACES_TABLE (default lcw-accounts, lcw-recovery, pws-spaces).
import '@interop/http-client'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { PwsClient } from '@interop/pws-client'
import { spaceUrlById } from '@interop/pws-client/paths/layout'
import { clientAnnexDidParts, ladderVmAgent, ladderVmZcapClient, mintSpaceVerbCapability } from '@interop/wallet-core/clientAnnex'
import { didKeyZcapClient } from '@interop/wallet-core/webvh'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { ensureRecoveryCode, loginWithPassphrase, registerAccount, sessionAgents, setSession } from '../../src/lib/identity'
import { passphraseCredential } from '../../src/lib/identity/credential'
import { fetchStandingRecord } from '../../src/lib/identity/records'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import { openTransientSession } from '../../src/lib/identity/transient'
import { readUnlockMethods } from '../../src/lib/identity/unlockMethods'
import { seedBadge } from './seedAccount'

export interface TestAccountConfig {
  apiBase: string
  serverUrl: string
}

export interface TestAccount {
  email: string
  passphrase: string
  config: TestAccountConfig
  // Known once the account is registered
  did?: string
  spaceId?: string
}

const trim = (url: string) => url.replace(/\/+$/, '')

export const accountConfig = (): TestAccountConfig => ({
  apiBase: trim(process.env.API_BASE ?? 'https://api.lcw-sandbox.org'),
  serverUrl: trim(process.env.WAS_URL ?? 'https://was.lcw-sandbox.org'),
})

const BACK_END_STACK = process.env.BACK_END_STACK ?? 'lcw-back-end'
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE ?? 'lcw-accounts'
const RECOVERY_TABLE = process.env.RECOVERY_TABLE ?? 'lcw-recovery'
const SPACES_TABLE = process.env.SPACES_TABLE ?? 'pws-spaces'

type Log = (line: string) => void
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// --- the record of the account a run made -----------------------------------

const stateFile = (name: string) => new URL(`../.test-account.${name}.json`, import.meta.url)

export function recordedAccount(name: string): TestAccount | null {
  const file = stateFile(name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as TestAccount) : null
}

const record = (name: string, account: TestAccount) => writeFileSync(stateFile(name), `${JSON.stringify(account, null, 2)}\n`)

// Records a passphrase a run has set on its account in place of the one it
// was made with, so that the account can still be opened to delete it.
export function recordPassphrase(name: string, passphrase: string): void {
  const account = recordedAccount(name)
  if (account) {
    record(name, { ...account, passphrase })
  }
}

function forget(name: string) {
  if (existsSync(stateFile(name))) {
    unlinkSync(stateFile(name))
  }
}

// --- AWS access ----------------------------------------------------------------

function aws<T>(args: string[]): T {
  let out: string
  try {
    out = execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    throw new Error(`The tests' account needs AWS access to the deployment (aws ${args.slice(0, 2).join(' ')}): ${detail}`)
  }
  return (out.trim() ? JSON.parse(out) : null) as T
}

let stackOutputs: Record<string, string> | null = null
function backEndOutput(key: string): string {
  stackOutputs ??= Object.fromEntries(
    aws<{ OutputKey: string; OutputValue: string }[]>(['cloudformation', 'describe-stacks', '--stack-name', BACK_END_STACK, '--query', 'Stacks[0].Outputs']).map((output) => [
      output.OutputKey,
      output.OutputValue,
    ])
  )
  const value = stackOutputs[key]
  if (!value) {
    throw new Error(`The ${BACK_END_STACK} stack has no ${key} output.`)
  }
  return value
}

// --- the email confirmation ----------------------------------------------------

// The confirmation link's token for a pending registration, percent-encoded
// as the email carries it: read from the scheduled email of the state
// machine's execution that is waiting on this address.
function pendingConfirmationToken(email: string): string | null {
  const stateMachineArn = backEndOutput('StateMachineArn')
  const { executions } = aws<{ executions: { executionArn: string }[] }>(['stepfunctions', 'list-executions', '--state-machine-arn', stateMachineArn, '--status-filter', 'RUNNING', '--max-results', '50'])
  for (const { executionArn } of executions) {
    const { input } = aws<{ input?: string }>(['stepfunctions', 'describe-execution', '--execution-arn', executionArn])
    if ((JSON.parse(input ?? '{}') as { recipientEmail?: string }).recipientEmail !== email) {
      continue
    }
    const { events } = aws<{ events: { taskScheduledEventDetails?: { parameters?: string } }[] }>(['stepfunctions', 'get-execution-history', '--execution-arn', executionArn, '--max-results', '20'])
    for (const event of events) {
      const parameters = event.taskScheduledEventDetails?.parameters
      const text = parameters ? (JSON.parse(parameters) as { Content?: { Simple?: { Body?: { Text?: { Data?: string } } } } }).Content?.Simple?.Body?.Text?.Data : undefined
      const token = text?.match(/[?&]token=(\S+)/)?.[1]
      if (token) {
        return token
      }
    }
  }
  return null
}

// Confirms the address of a registration that was just started: opens the
// link the confirmation email carries, then waits, as its page does, for
// the back end to have recorded the account.
async function confirmRegistration(email: string, log: Log): Promise<void> {
  const confirmUrl = backEndOutput('ConfirmUrl')
  let token: string | null = null
  for (let attempt = 0; attempt < 20 && token === null; attempt++) {
    token = pendingConfirmationToken(email)
    if (token === null) {
      await wait(1500)
    }
  }
  if (token === null) {
    throw new Error(`No registration is waiting for ${email} to be confirmed.`)
  }
  const opened = await fetch(`${confirmUrl}?token=${token}`)
  if (!opened.ok) {
    throw new Error(`The confirmation link answered ${opened.status}.`)
  }
  const key = createHash('sha256').update(decodeURIComponent(token)).digest('hex')
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = (await (await fetch(`${confirmUrl}/status?key=${key}`)).json().catch(() => ({}))) as { ready?: boolean }
    if (status.ready) {
      log('the email is confirmed and the back end has recorded the account')
      return
    }
    await wait(1000)
  }
  throw new Error('The back end did not record the account within a minute of the confirmation.')
}

// --- creating -------------------------------------------------------------------

// Registers, confirms and seeds a new account, deleting first any account an
// earlier run under the same name left behind.
export async function createTestAccount({ name, seed = true, log = console.log }: { name: string; seed?: boolean; log?: Log }): Promise<TestAccount> {
  const registrationCode = process.env.REGISTRATION_CODE
  if (!registrationCode) {
    throw new Error("Set REGISTRATION_CODE: the tests register an account of their own, which takes the deployment's registration code.")
  }
  const leftover = recordedAccount(name)
  if (leftover) {
    log(`deleting the account an earlier run left behind (${leftover.email})`)
    await deleteTestAccount({ name, log })
  }
  // Checked before anything is created: the confirmation cannot happen without it
  backEndOutput('StateMachineArn')

  const account: TestAccount = {
    email: `success+lcw-${name}-${randomBytes(5).toString('hex')}@simulator.amazonses.com`,
    passphrase: `lcw tests ${randomBytes(18).toString('base64url')}`,
    config: accountConfig(),
  }
  // Recorded before it exists, so a registration that is cut short is
  // still found and deleted by the next run
  record(name, account)
  log(`registering ${account.email}`)
  await registerAccount({ email: account.email, passphrase: account.passphrase, registrationCode, config: account.config })
  await confirmRegistration(account.email, log)
  // The account signs in, which is what every test starts with
  const session = await loginWithPassphrase({ email: account.email, passphrase: account.passphrase, config: account.config })
  account.did = session.did
  account.spaceId = session.spaceId
  record(name, account)
  setSession(session)
  // What the sign-in page does in the background after a first sign-in,
  // run to its end here: the account's recovery code is issued, listed and
  // handed to the back end. A test that signs in and is over within
  // seconds would otherwise cut that short, after the code's unlock Space
  // exists and before the account lists it, and nothing could delete that
  // Space afterwards; the next sign-in would then issue another.
  await ensureRecoveryCode({ session, config: account.config })
  if (seed) {
    const { name: credentialName, cid } = await seedBadge(session)
    log(`seeded "${credentialName}" as ${cid}`)
  }
  log(`account ready: Space ${account.spaceId}`)
  return account
}

// --- deleting -------------------------------------------------------------------

export interface DeletionReport {
  // Spaces deleted through the PWS server, by what they were
  deleted: string[]
  // What could not be deleted, or was still registered afterwards
  left: string[]
  // The back-end rows removed
  rows: string[]
}

async function deleteSpace({ serverUrl, spaceId, zcapClient, capability }: { serverUrl: string; spaceId: string; zcapClient: ZcapClient; capability?: IZcap }): Promise<boolean> {
  const pws = new PwsClient({ baseServerUrl: serverUrl, zcapClient, serviceDescription: await serviceDescriptionFor(serverUrl) })
  const { outcome } = await pws.space(spaceId, capability ? { capability } : undefined).deleteWithOutcome()
  return outcome === 'deleted'
}

// Deletes the account's Spaces with the account's own authority, as far as
// the passphrase reaches: every other sign-in method's unlock Space (through
// the management capability its credential delegated to the account), the
// client-annex Space, the account Space, and last the passphrase's own
// unlock Space, which the passphrase controls by itself. The passphrase
// signs nothing as the account; its ladder key delegates a DELETE of
// exactly one Space at a time, which the server admits.
async function deleteSpaces(account: TestAccount, report: DeletionReport, log: Log): Promise<void> {
  const { serverUrl } = account.config
  const credential = await passphraseCredential(account.passphrase)
  const found = await fetchStandingRecord({ credential, serverUrl }).catch(() => null)
  if (!found) {
    // Nothing the passphrase opens: the registration never got that far
    return
  }
  const attempt = async (what: string, run: () => Promise<boolean>) => {
    try {
      ;((await run()) ? report.deleted : report.left).push(what)
    } catch (err) {
      report.left.push(`${what} (${(err as Error).message})`)
    }
  }
  if (found.ladderSeed && found.pointer.did) {
    const ladderSeed = found.ladderSeed
    const ladderAgent = await ladderVmAgent({ ladderSeed })
    const ladderDid = ladderAgent.id.split('#')[0]
    const asLadder = didKeyZcapClient({ keyAgent: ladderAgent })
    const delegating = await ladderVmZcapClient({ accountDid: found.pointer.did, ladderSeed })
    // A DELETE of one Space the account controls, delegated to the ladder's own did:key
    const deleteOwn = async (spaceId: string) =>
      deleteSpace({
        serverUrl,
        spaceId,
        zcapClient: asLadder,
        capability: await delegating.delegate({
          invocationTarget: spaceUrlById({ baseServerUrl: serverUrl, spaceId }),
          controller: ladderDid,
          allowedActions: ['DELETE'],
          expires: new Date(Date.now() + 10 * 60 * 1000),
        }),
      })

    const entry = await openTransientSession({ credential, found, serverUrl }).catch((err: Error) => {
      report.left.push(`the account could not be opened to list its sign-in methods (${err.message})`)
      return null
    })
    if (entry) {
      const session = { ...entry.session, email: account.email }
      const { signer, capabilityFor } = await sessionAgents(session)
      const pws = PwsClient.fromSigner({ baseServerUrl: serverUrl, signer, serviceDescription: await serviceDescriptionFor(serverUrl) })
      const registry = await readUnlockMethods({ pws, spaceId: session.spaceId, userKey: session.userKey, capability: capabilityFor(session.spaceId) }).catch(() => null)
      for (const method of registry?.record.methods ?? []) {
        if (method.unlockSpaceId === session.unlockSpaceId) {
          continue
        }
        const what = `the unlock Space of a ${method.type} (${method.unlockSpaceId})`
        const parent = method.manageCapability
        if (!parent) {
          report.left.push(`${what}: listed without a management capability`)
          continue
        }
        await attempt(what, async () =>
          deleteSpace({
            serverUrl,
            spaceId: method.unlockSpaceId,
            zcapClient: asLadder,
            capability: await mintSpaceVerbCapability({ zcapClient: delegating, parent, verb: 'DELETE', controller: ladderDid }),
          })
        )
      }
      const annexSpaceId = clientAnnexDidParts({ did: session.clientAnnexDid }).spaceId
      await attempt(`the client-annex Space (${annexSpaceId})`, () => deleteOwn(annexSpaceId))
      // Last of the account's own: the ladder key is known through the
      // account document, which this Space serves
      await attempt(`the account Space (${session.spaceId})`, () => deleteOwn(session.spaceId))
    }
  }
  await attempt(`the passphrase's unlock Space (${credential.unlock.spaceId})`, () => deleteSpace({ serverUrl, spaceId: credential.unlock.spaceId, zcapClient: credential.unlock.zcapClient }))
  log(`deleted ${report.deleted.length} Space(s)`)
}

// The Spaces the registry still holds for the account: the account Space
// itself, and any Space created under it.
function spacesStillRegistered(account: TestAccount): string[] {
  if (!account.spaceId) {
    return []
  }
  const url = `${account.config.serverUrl}/space/${account.spaceId}`
  const { Items } = aws<{ Items: { spaceURL: { S: string } }[] }>([
    'dynamodb',
    'scan',
    '--table-name',
    SPACES_TABLE,
    '--filter-expression',
    'spaceURL = :url OR #account = :url',
    '--expression-attribute-names',
    '{"#account":"account"}',
    '--expression-attribute-values',
    JSON.stringify({ ':url': { S: url } }),
    '--projection-expression',
    'spaceURL',
  ])
  return Items.map((item) => item.spaceURL.S)
}

// Deletes the account a run recorded under the name: its Spaces, then the
// back end's rows for its email. Resolves to what was deleted and what was
// left; the record is removed either way, since a second attempt could do
// no more than this one.
export async function deleteTestAccount({ name, log = console.log }: { name: string; log?: Log }): Promise<DeletionReport> {
  const report: DeletionReport = { deleted: [], left: [], rows: [] }
  const account = recordedAccount(name)
  if (!account) {
    return report
  }
  await deleteSpaces(account, report, log).catch((err: Error) => report.left.push(`the account's Spaces (${err.message})`))
  for (const table of [ACCOUNTS_TABLE, RECOVERY_TABLE]) {
    const removed = aws<{ Attributes?: unknown } | null>(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify({ email: { S: account.email } }), '--return-values', 'ALL_OLD'])
    if (removed?.Attributes) {
      report.rows.push(table)
    }
  }
  for (const url of spacesStillRegistered(account)) {
    report.left.push(`still registered: ${url}`)
  }
  forget(name)
  log(`account ${account.email} deleted: ${report.deleted.length} Space(s), ${report.rows.length} back-end row(s)`)
  for (const item of report.left) {
    log(`LEFT BEHIND: ${item}`)
  }
  return report
}

// Runs something against an account of its own, created before and deleted
// after, whatever the run did.
export async function withTestAccount<T>(name: string, run: (account: TestAccount) => Promise<T>): Promise<T> {
  const account = await createTestAccount({ name })
  try {
    return await run(account)
  } finally {
    await deleteTestAccount({ name }).catch((err: Error) => console.error(`The account could not be deleted: ${err.message}`))
  }
}
