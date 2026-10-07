# AGENTS.md

Notes for agents and developers working on the Learner Credential Wallet front
end. `README.md` covers the app itself; this file covers running the whole
wallet locally, which spans three services.

## The three repos

The wallet is not one service. A working environment needs all three, checked
out as siblings:

| Repo | Role | Local port |
| --- | --- | --- |
| `lcw-front-end` (this one) | React + Vite UI | 5173 |
| `lcw-back-end` | the login API (`POST /login`), the spaces API (`/spaces`) and registration flow | 3001 |
| `was-server-aws` | Wallet Attached Storage — the account's spaces | 3000 |

The front end also needs a fourth sibling, though not as a service:
`package.json` links `@digitalcredentials/batch-issuer-ui` as
`file:../batch-issuer-ui`, so `npm install` fails without it. Clone it next to
the others and build it once:

```bash
git clone https://github.com/digitalcredentials/batch-issuer-ui.git
cd batch-issuer-ui && npm ci && npm run build
```

Rebuild it after pulling changes to it; this repo uses its built `dist/`. CI
pins it to one commit (the `ref` in `.github/workflows/ci.yml`); if your
checkout's dependencies differ from that commit's, `npm ci` here fails until
`package-lock.json` is refreshed against it.

How a login flows through them:

1. The UI derives an Ed25519 key from the passphrase — `SHA-256(passphrase)` is
   the seed, so one passphrase always yields one `did:key`
   (`src/lib/login.ts`).
2. It signs a zCap invocation of **lcw-back-end**'s `POST /login`. That Lambda
   looks the email up in the `wallet-test` DynamoDB table and verifies the
   signature against the DID registered there. On success it returns the
   account's spaces, read from the `wallet-spaces` registry table.
3. The UI lists those spaces (through `GET /spaces`, the same zCap scheme), and
   talks to **was-server-aws** at the chosen space's URL, signing every request
   with the same key. A Lambda authorizer looks that URL up in the *same*
   `wallet-spaces` registry, takes the controller DID registered for it, and
   rejects anything not signed by it.

So there are two shared tables: `wallet-test` is identity only (email → DID),
and `wallet-spaces` holds one row per space, keyed by its URL. Both back ends
read the registry. The space's contents live in S3 — one bucket per space,
named for the space id.

## Local stack

`sam local` runs the two back ends, but their Lambdas talk to **real** AWS by
default: the shared `wallet-test` and `wallet-spaces` DynamoDB tables and real
S3 buckets. Rather than depend on DCC AWS credentials, the local stack
substitutes both:

- **DynamoDB Local** (`amazon/dynamodb-local`) on `:8000` for both tables
- **MinIO** (`minio/minio`) on `:9000` for the space's S3 bucket (console `:9001`)

Both run on a Docker network named `lcw-local`, which the `sam local` Lambda
containers join so they can reach them by container name. Nothing touches AWS
and no credentials are needed.

It is not fully offline, though: `seed.mjs` signs the Bachelors credential, and
signing resolves the JSON-LD contexts the credential references over the
network (`w3.org`, `purl.imsglobal.org`, `w3id.org`). They are cached per run,
not vendored, so seeding on a disconnected machine fails in `documentLoader`
with a context fetch error rather than anything about AWS.

### Bring it up

```bash
cd scripts/local-stack
npm install          # first time only
./up.sh
```

`up.sh` is idempotent. It creates the network, starts the two substitute
containers, runs `sam build` for both back ends, patches the built templates
(see below), and seeds the demo account and space.

It then prints the three foreground processes to start, each in its own
terminal, with **absolute paths for your checkout** — use what it prints. The
shape, written from the directory that holds all three repos as siblings:

```bash
# the space, on :3000
cd was-server-aws && AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest AWS_SESSION_TOKEN= \
  sam local start-api --port 3000 --region us-east-1 \
  --docker-network lcw-local --warm-containers EAGER

# the login and spaces API, on :3001
cd lcw-back-end && AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest AWS_SESSION_TOKEN= \
  sam local start-api --port 3001 --region us-east-1 \
  --env-vars env.json --docker-network lcw-local --warm-containers EAGER

# the front end, on :5173
cd lcw-front-end && npm run dev
```

Each path is relative to the repos' shared parent, not to
`scripts/local-stack` where you ran `up.sh`.

Keep the credentials on both `sam` commands. `sam local` passes the shell's own
AWS credentials into the Lambda containers, and they beat the `localtest` values
the template patch sets, so from a shell holding real credentials (exported
keys, or a live SSO or assume-role session) every S3 call fails with
`InvalidAccessKeyId` or `InvalidTokenId` and the space returns 500. Setting
them on the command makes `localtest` the credentials `sam` resolves.

Sign in at http://localhost:5173:

| | |
| --- | --- |
| Email | `jc.chartrand@gmail.com` |
| Passphrase | `my-secret-seed-that-is-long-enou` |

`.env` (gitignored) must point the UI at the local login API:

```
VITE_API_BASE_URL=http://localhost:3001
```

### Signing in as yourself instead of the demo user

Registration does not work locally (see below), so a local account is created by
seeding it:

```bash
SEED_EMAIL=you@example.org SEED_PASSPHRASE='your passphrase' node scripts/local-stack/seed.mjs
```

That registers your email alongside the demo account and gives it **its own**
space, seeded with the same two credentials. It gets its own space rather than
sharing the demo one on purpose: the registry is keyed by space URL, so a space
has exactly one controller row, and registering a second account on the demo
space would overwrite the demo's row and hand the space to the other DID.

The demo account is always seeded too, because the e2e tests hard-code its email
and space id — so don't replace it, and keep running the suite as the demo user.

### Registration does not work locally

`POST /register` starts a Step Functions state machine, which then sends SES mail
and waits on a confirmation link. `sam local` emulates neither Step Functions nor
SES, so the register flow cannot complete against the local stack. Seed accounts
instead. Registering on the deployed sandbox is a separate thing and does work.

### What the seed script creates

`scripts/local-stack/seed.mjs` writes, idempotently:

- the `wallet-test` and `wallet-spaces` tables, with the same keys and
  `by-email` index as `lcw-back-end`'s template
- the demo account in `wallet-test` — its `did` is *derived* from the
  passphrase rather than stored, so the tables always agree with whatever the
  login page derives
- its space in `wallet-spaces`, as registration would: type `credential`,
  named `<email>'s Space`, at `http://localhost:3000/space/<space id>`. The
  authorizer looks this URL up **as the exact key**, so a sandbox account
  (whose space URL points at the deployed WAS) will not drive the local space
- the space's S3 bucket, named for the space id
  `dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c`, which the e2e tests hard-code
- the space and `UniversityOfToronto` collection descriptions, plus the
  `LCWExperience.json` and `Bachelors.json` credentials

To reset the space:

```bash
AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest AWS_SESSION_TOKEN= \
  aws s3 rm s3://dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/ --recursive \
  --endpoint-url http://localhost:9000
node scripts/local-stack/seed.mjs
```

## Five things that will bite you

These were each a dead end once. They are why `up.sh` and
`patch-built-template.mjs` exist.

Re-run `sam build` before any deploy of either back end. `sam deploy` defaults
to `.aws-sam/build/template.yaml`, and neither back end pins `template_file`, so
deploying straight after using the local stack picks up a patched template full
of container-name endpoints and `localtest` credentials. CloudFormation rejects
the reserved `AWS_*` keys, so it fails rather than deploying something wrong —
but it fails confusingly, and a fresh `sam build` discards the patch.

**1. `sam local` only injects env vars the template already declares.** So the
endpoint overrides cannot come from `--env-vars`, and `--container-env-vars`
applies only to debug sessions. `scripts/local-stack/patch-built-template.mjs`
therefore injects them into `Globals.Function.Environment.Variables` of the
**built** template in `.aws-sam/build`, which is generated and gitignored — the
deployable `template.yaml` stays untouched. **Re-run it after every
`sam build`**, which drops the patch.

**2. `sam local` serves `.aws-sam/build`, not `src/`.** Editing a handler does
nothing until you `sam build` again (and then re-patch). A stale build is the
most likely reason a change appears to have no effect.

**3. `lcw-back-end`'s table names are `!Ref`s.** Outside CloudFormation
`sam local` resolves `TABLE_NAME` and `SPACES_TABLE_NAME` to the literal
logical ids `WalletTestTable` and `WalletSpacesTable`, so the Lambdas query
tables that do not exist. `lcw-back-end/env.json` overrides them back to
`wallet-test` and `wallet-spaces` for the login and spaces functions (and
points the spaces function's `SPACE_URL_BASE` at the local WAS), which is why
that API needs `--env-vars env.json`. Function-level values beat the `Globals`
injection, so these overrides cannot live in the patch. `up.sh` merges them into
`env.json` on every run, keeping any other keys you have added.

**4. Never run `up.sh` while `sam local` is running.** `up.sh` runs `sam build`,
which deletes and recreates `.aws-sam/build`. A running `sam local start-api`
with `--warm-containers EAGER` has those exact paths mounted into its
containers, so the rebuild pulls the directory out from under them. It does not
fail as a build error. Routes start returning
`Runtime.ImportModuleError: Cannot find module 'app'` and
`shell-init: getcwd: cannot access parent directories`, which read like broken
code and are not. A suite that normally takes a minute took six and failed ten
tests this way. `up.sh` now refuses to run if it finds a `sam local` process, so
the order is: stop the APIs, run `up.sh`, start the APIs again.

**5. DynamoDB Local needs `-sharedDb`.** Without it, tables are namespaced per
access-key/region pair, and the seed script and the Lambdas end up looking at
two different namespaces — the table is created, and the Lambda still reports
`ResourceNotFoundException`.

### The one source change the local stack required

Every S3 client in `was-server-aws` — each handler under `src/collections`,
`src/resources` and `src/spaces`, plus `src/policies/app.mjs` and
`src/authorizer/publicRead.mjs` — is constructed as:

```js
const s3 = new S3Client(
  process.env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {}
);
```

S3's default virtual-host addressing puts the bucket in the hostname
(`my-bucket.lcw-minio`), which does not resolve for a substitute reached by
container name. The installed AWS SDK has no `AWS_S3_FORCE_PATH_STYLE` env var,
so path style has to be set in code. It is gated on the endpoint override, which
is never set in a deployed environment, so real S3 behaviour is unchanged.

This change is not committed upstream, so a fresh checkout of `was-server-aws`
does not have it and **anything new that reaches S3 needs it applied too**.
`up.sh` checks every file constructing an `S3Client` before it builds, and stops
with the list if any lacks it — otherwise the stack comes up, prints `Ready`,
and hangs on the first space request. A handler that misses it does not fail
loudly: the request simply hangs until the caller times out, because
`bucket.lcw-minio` never resolves.

`lcw-back-end`'s spaces function (`src/lcw-spaces`) builds its own S3 client
without this, and `up.sh` does not check it. Listing spaces never touches S3,
so sign-in and browsing work, but **New Space** and deleting a batch space hang
against the local stack until it gets the same change.

## Tests

```bash
npm run test:e2e:local     # Playwright, against the local stack
```

That script is the one to use. It exports the local S3 endpoint, so the tests
that clean up after themselves with the `aws` CLI (through `removeFromSpace`)
target MinIO instead of real S3, and it pins the suite to one worker and to
`tests/e2e.spec.ts`:

```bash
LOCAL_S3_URL=http://localhost:9000 \
AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest AWS_SESSION_TOKEN= \
  playwright test tests/e2e.spec.ts --workers=1
```

`AWS_SESSION_TOKEN=` is not decoration. If you have a live SSO or assume-role
session in the shell, its token is inherited, MinIO rejects it with
`InvalidTokenId`, and the tests that clean up after themselves fail with
nothing pointing at the cause. Clearing it is what makes the static
`localtest` credentials take effect.

Bare `npm run test:e2e` is `playwright test` with no arguments. It runs the
whole `tests/` directory in parallel with none of that environment, so the
cleanup steps aim at real S3 and the suite fights itself. `tests/deployed.spec.ts`
is safe either way — it skips unless `DEPLOYED_URL` is set.

Use `--workers=1`. Every request is a `sam local` Lambda invocation, so the
suite is slow and parallel runs fight over the same space. Occasional flakes
under load are timeouts, not regressions — re-run the single test with `-g` to
confirm.

Start the WAS API with `--warm-containers EAGER` too. Without it every route
pays a cold start, and the verifier tests time out waiting on the space; with
it the suite takes about a minute rather than five.

The other two suites need no local stack:

```bash
cd ../was-server-aws && npm test    # 38 in-process handler, authorizer and policy tests
cd ../lcw-back-end/src/lcw-login && npm test
```

### Known gap: most credential tests predate the card view

The e2e suite was last updated before `main` moved collections and credentials
from tables to cards, with a credential's actions (Verify, Share, View Source,
Delete) behind **Open**. The 13 tests that find a collection or credential by
`getByRole('row')` fail against any stack, local or deployed, until they are
rewritten for the cards. The 8 that cover sign-in, registration errors, the
collections list and staging a credential pass. `logIn` already handles the
newer sign-in flow: it dismisses the browser-wallet prompt and opens the demo
space.

A failing test also skips its own cleanup, so after a failed run reset the
space (below) before trusting the next one.

### Known gap: `Bachelors.json` is not from a trusted issuer

The verifier only accepts the two issuer DIDs listed in `ISSUER_DIDS`
(`src/pages/SpaceBrowserPage.tsx`). `LCWExperience.json` is the repo's own
signed fixture (`tests/fixtures/PlaywrightUpload.json`), whose issuer is one of
them, so it verifies fully. No signed `Bachelors` credential exists in the repo,
so `seed.mjs` signs one with a deterministic throwaway key. Its signature is
valid but its issuer is unknown, so the verifier shows **"Not a known issuer."**
and the test `verifies a second credential after the first` fails locally.

To close this, seed a real DCC-signed "Bachelors in Computer Science"
credential: save it as `tests/fixtures/Bachelors.json` and have `seed.mjs`
upload it instead of signing its own. It can be read from the sandbox demo
account's space (`jc.chartrand+aws@gmail.com`, see `tests/deployed.spec.ts`), or
obtained from whoever maintains the sandbox.

## Tearing down

```bash
docker rm -f lcw-dynamodb lcw-minio
docker network rm lcw-local
```

Both substitutes are in-memory, so everything is gone on teardown; re-run
`up.sh` to rebuild it.

## Deploying

Don't, casually — `npm run build` bakes in `.env.production`
(`https://api.lcw-sandbox.org`) and the deploy targets the shared sandbox at
https://lcw-sandbox.org. See the Deploy section of `README.md`, and check with
the sandbox maintainer first.
