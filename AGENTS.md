# AGENTS.md

Notes for agents and developers working on the Learner Credential Wallet front
end. `README.md` covers the app itself; this file covers running the whole
wallet locally, which spans three repos.

## The three repos

The wallet is not one service. A working environment needs all three, checked
out as siblings:

| Repo | Role | Local port |
| --- | --- | --- |
| `lcw-front-end` (this one) | React + Vite UI | 5173 |
| `lcw-back-end` | the login API (`POST /login`) and registration flow | 3001 |
| `was-server-aws` | Wallet Attached Storage — the account's space | 3000 |

How a login flows through them:

1. The UI derives an Ed25519 key from the passphrase — `SHA-256(passphrase)` is
   the seed, so one passphrase always yields one `did:key`
   (`src/lib/login.ts`).
2. It signs a zCap invocation of **lcw-back-end**'s `POST /login`. That Lambda
   looks the email up in the `wallet-test` DynamoDB table and verifies the
   signature against the DID registered there. On success it returns the
   account's `spaceURL`.
3. The UI then talks to **was-server-aws** at that `spaceURL`, signing every
   request with the same key. A Lambda authorizer re-resolves the space's
   controller DID from the *same* `wallet-test` table and rejects anything not
   signed by it.

So both back ends read one shared accounts table, and the space's contents live
in S3 — one bucket per space, named for the space id.

## Local stack

`sam local` runs the two back ends, but their Lambdas talk to **real** AWS by
default: the shared `wallet-test` DynamoDB table and real S3 buckets. Rather
than depend on DCC AWS credentials, the local stack substitutes both:

- **DynamoDB Local** (`amazon/dynamodb-local`) on `:8000` for the accounts table
- **MinIO** (`minio/minio`) on `:9000` for the space's S3 bucket (console `:9001`)

Both run on a Docker network named `lcw-local`, which the `sam local` Lambda
containers join so they can reach them by container name. Nothing touches AWS
and no credentials are needed.

### Bring it up

```bash
cd scripts/local-stack
npm install          # first time only
./up.sh
```

`up.sh` is idempotent. It creates the network, starts the two substitute
containers, runs `sam build` for both back ends, patches the built templates
(see below), and seeds the demo account and space. Then start the three
foreground processes, each in its own terminal:

```bash
# the space, on :3000
cd ../was-server-aws && sam local start-api --port 3000 --region us-east-1 \
  --docker-network lcw-local --warm-containers EAGER

# the login API, on :3001
cd ../lcw-back-end && sam local start-api --port 3001 --region us-east-1 \
  --env-vars env.json --docker-network lcw-local --warm-containers EAGER

# the front end, on :5173
npm run dev
```

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
sharing the demo one on purpose: the authorizer finds an account by scanning the
table for an exact `spaceURL` match and takes the first hit, so two accounts
pointing at one space would resolve to whichever row came back first and verify
against the wrong DID.

The demo account is always seeded too, because the e2e tests hard-code its email
and space id — so don't replace it, and keep running the suite as the demo user.

### Registration does not work locally

`POST /register` starts a Step Functions state machine, which then sends SES mail
and waits on a confirmation link. `sam local` emulates neither Step Functions nor
SES, so the register flow cannot complete against the local stack. Seed accounts
instead. Registering on the deployed sandbox is a separate thing and does work.

### What the seed script creates

`scripts/local-stack/seed.mjs` writes, idempotently:

- the `wallet-test` table, and the demo account in it — its `did` is *derived*
  from the passphrase rather than stored, so the table always agrees with
  whatever the login page derives
- the account's `spaceURL` as `http://localhost:3000/space/<space id>`. The
  authorizer matches this **by exact string**, so a sandbox account (whose
  `spaceURL` points at the deployed WAS) will not drive the local space
- the space's S3 bucket, named for the space id
  `dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c`, which the e2e tests hard-code
- the space and `UniversityOfToronto` collection descriptions, plus the
  `LCWExperience.json` and `Bachelors.json` credentials

To reset the space:

```bash
AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest \
  aws s3 rm s3://dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/ --recursive \
  --endpoint-url http://localhost:9000
node scripts/local-stack/seed.mjs
```

## Four things that will bite you

These were each a dead end once. They are why `up.sh` and
`patch-built-template.mjs` exist.

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

**3. The login function's `TABLE_NAME` is a `!Ref`.** Outside CloudFormation
`sam local` resolves it to the literal logical id `WalletTestTable`, so the
Lambda queries a table that does not exist. `lcw-back-end/env.json` overrides
it back to `wallet-test`, which is why that API needs `--env-vars env.json`.
Function-level values beat the `Globals` injection, so this override cannot
live in the patch.

**4. DynamoDB Local needs `-sharedDb`.** Without it, tables are namespaced per
access-key/region pair, and the seed script and the Lambdas end up looking at
two different namespaces — the table is created, and the Lambda still reports
`ResourceNotFoundException`.

### The one source change the local stack required

Every S3 client in `was-server-aws` — the seven resource handlers, plus
`src/policies/app.mjs` and `src/authorizer/publicRead.mjs` from the
access-control work — is constructed as:

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

This change is not committed upstream, so **anything new that reaches S3 needs
it applied too**. A handler that misses it does not fail loudly: the request
simply hangs until the caller times out, because `bucket.lcw-minio` never
resolves.

## Tests

```bash
npm run test:e2e        # Playwright, against the local stack
```

Run the suite with the local S3 endpoint exported, so the tests that clean up
after themselves with the `aws` CLI (through `removeFromSpace`) target MinIO
instead of real S3:

```bash
LOCAL_S3_URL=http://localhost:9000 \
AWS_ACCESS_KEY_ID=localtest AWS_SECRET_ACCESS_KEY=localtest \
  npx playwright test tests/e2e.spec.ts --workers=1
```

Use `--workers=1`. Every request is a `sam local` Lambda invocation, so the
suite is slow and parallel runs fight over the same space. Occasional flakes
under load are timeouts, not regressions — re-run the single test with `-g` to
confirm.

Start the WAS API with `--warm-containers EAGER` too. Without it every route
pays a cold start, and the verifier tests time out waiting on the space; with
it the suite takes about a minute rather than five.

The other two suites need no local stack:

```bash
cd ../was-server-aws && npm test    # 34 in-process handler, authorizer and policy tests
cd ../lcw-back-end/src/lcw-login && npm test
```

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
