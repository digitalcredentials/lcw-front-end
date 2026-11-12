# lcw-front-end

The web front end for the Learner Credential Wallet (LCW): a React + TypeScript
+ Vite app for signing in with a passphrase that unlocks the account's keys,
browsing the account's
[Wallet Attached Storage](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
spaces, adding, viewing, sharing, moving, deleting, and verifying Verifiable
Credentials, claiming and presenting them over [CHAPI](https://chapi.io/), and
mounting plugins such as the
[batch-issuer-ui](https://github.com/digitalcredentials/batch-issuer-ui) panel
for issuing batches of credentials. Credential collections are end-to-end
encrypted (EDV over WAS); the server stores ciphertext it cannot read.

## How it works

- **Identity** (`src/lib/identity/`): the account is
  [`@interop/wallet-core`](https://www.npmjs.com/package/@interop/wallet-core)'s
  credential-anchored account, the model FreeWallet uses, so an account
  made here is a web space another wallet can join. Nothing about the
  account derives from the passphrase: registration (`signup.ts`) mints the
  account's keys at random, and the passphrase only derives an **unlock
  credential** (wallet-core's keyring derivation, FreeWallet's salts) that
  opens them. A bootstrap `did:key` creates two Spaces through the PWS
  server's `POST /spaces/` with the registration code as coupon, and the
  passphrase's unlock Space is created the same way under its unlock
  identity (`provision.ts`): every Space this wallet makes, the unlock
  Spaces of later passkeys and recovery codes included, redeems the coupon
  (the registration token `/login` returns), so the server's capped
  coupon-less path is never used for its accounts. The
  **account Space** holds the account's `did:webvh` log in its
  world-readable `id` collection (served through the identity domain,
  `VITE_ID_DOMAIN`), the user key (X25519, the recipient of every encrypted
  collection, one per account), the **user-key roster**
  (`account/user-key.json`: the user key wrapped to each credential's
  unlock key) and the **unlock-methods registry**
  (`unlock-methods/methods.json`, FreeWallet's shape member for member, the
  list behind Settings → Sign-in credentials). The **client annex** Space
  carries a `did:webvh` of its own, named by the account document's
  `DelegatedClients` service entry. The credential's own small **unlock
  Space** holds its signed pointer record and a sealed record of its keys.
  Both Spaces are promoted to the account DID; just before that, the email
  is recorded against the account DID with the lcw-back-end
  (`POST /register`, which emails the confirmation link). Sign-in opens
  one of two session kinds (`session.ts`). A **transient session**, from
  the password or a recovery code, signs as the client annex under a
  delegation the annex holds for the account Space, so it reads and writes
  the account Space and nothing else: it signs in to the back end
  (`POST /login`, which verifies the annex against the account document
  and returns the registration token, the PWS server's space-creation
  coupon), claims credentials with a fresh `did:key`, and refuses to
  create, rename or delete Spaces, to notify the batch issuer, and to sign
  a presentation as the account (`PasskeySessionRequiredError`: those need
  a passkey). A **remembered session**, from a passkey, signs as the
  account itself and reaches every Space. It holds a client key record in
  IndexedDB (`lcw-session`), sealed to the passkey's unlock key; the first
  passkey sign-in on a browser enrolls that browser's client key in the
  account document (`remembered.ts`). On a browser holding a record, the
  signed-in pages offer **Continue with passkey** before the login form
  (`RequireAuth`). Either session's keys live in this tab's
  `sessionStorage`: gone when the tab closes, and the CHAPI popup, a window
  of its own, signs the user in itself. **Passkeys** (`passkey.ts`,
  `standing.ts`): after a password sign-in on a browser that supports them,
  the login page offers **Add a passkey?** (once per account and browser;
  Not now is remembered) and offers **Sign in with a passkey** beside the
  form. A passkey is a credential of its own: the WebAuthn PRF extension
  (FreeWallet's input and derivation) gives it its unlock secret, and
  adding it (`addStandingCredential`) delegates it a write on the account
  log, publishes its unlock key to the account document, adds its roster
  recipient, writes its unlock Space and lists it in the registry.
  Authenticators without PRF support are refused. The back end's
  `POST /login` accepts an invocation signed by any key the account
  document lists or by the client annex it names. **Recovery**
  (`recovery.ts`, `src/pages/ForgotPage.tsx`): the recovery code is a
  credential of its own (uppercase base32 in groups of four, derived with
  HKDF under a salt of its own). After any sign-in, an account with no code
  stored at the back end gets one, issued and stored there (`PUT
  /recovery`, encrypted); the user never sees it, because it reaches them
  by email. **Forgot your password?** asks the back end to mail it
  (`POST /forgot`); the recovery page takes the code and a new password,
  opens the account through the code (a transient session), adds the new
  password as a further credential, and replaces the used code with a
  fresh one at the back end. **Sign-in credentials**
  (`src/pages/CredentialsPage.tsx`, `unlockMethods.ts`, under
  **Settings**): the registry's methods (the password, each passkey, the
  recovery code), with **Add a passkey** and, on a remembered browser,
  **Forget this browser**, which drops the browser's client key record
  (the client stays listed in the account document until it is
  disconnected). Removing a sign-in method, disconnecting a client and
  rotating the user key are not offered yet on this model, so a password
  replaced through recovery stays valid until they are. Requests sign as
  `<did:webvh>#<multibase>`; only the creation of a Space uses a key's
  `did:key` form, which the server requires, before the Space is promoted.
  On the first open after registering, the
  wallet offers to issue a **welcome credential** (the test issuer's LCW
  Sandbox Badge) and, in the same flow, to enable the browser wallet
  (`src/lib/welcome.ts`, the dialog in `src/components/AppShell.tsx`).
- **My Spaces** (`src/pages/SpaceBrowserPage.tsx`, `src/lib/spaces.ts`): the
  account's spaces as cards (the WAS server's `GET /spaces/`), with names
  and descriptions read from each space's Space Metadata object
  (`/space/{s}/meta`). The user does not create spaces: the account has its
  one account space, the model FreeWallet shares, and the only other
  spaces are batch spaces, which the batch issuer creates when a batch is
  saved (`createSpace` in `src/lib/spaces.ts`, through the server's
  `POST /spaces/` with the coupon under the session's client key, then
  handed to the account DID, which the server allows only to a key the
  account document lists) and deletes with the batch. Renaming and describing a space replaces its
  metadata object under `If-Match`. A space whose type array carries
  `BatchSpace` is a batch space: its card asks whether to open the batch
  view or the standard space view. Creating, renaming and deleting spaces
  sign as the account, so they need a session opened with a passkey; a
  password session lists the account space alone and says so when asked
  for more.
- **Space browser**: a space's collections and resources through
  [`@interop/pws-client`](https://www.npmjs.com/package/@interop/pws-client),
  signing every request with the account's signing key. Collections and credentials are
  cards; a collection's display name and description come from its `/meta`
  sub-resource (`collectionDisplay` in `src/lib/edv.ts`, with the description
  document as the fallback for collections that predate `/meta`). **New
  Collection** creates an encrypted collection through the server's
  `POST /space/{id}/` route. Opening a credential shows a formatted summary
  with its source and a live verification (every plugin filling the
  `credentialDetail` slot; today the
  [verifier-plugin](https://github.com/digitalcredentials/verifier-plugin)
  card) side by side, plus
  **Share**, **Move** (between collections), and **Delete** (a copy into the
  space's `Trash` collection, from which **Restore** moves it back out; the
  server's delete is permanent, so the wallet does the copy itself).
  Every state that waits on the network shows a `LoadingLabel` with a spinner
  and a message rather than a placeholder.
- **End-to-end encryption** (`src/lib/edv.ts`): collections the wallet
  creates — credential collections, `dids`, `Trash` — carry the pws-client's
  `encryption: { scheme: 'edv' }` descriptor. The session's Ed25519 key is
  converted to an X25519 key-agreement key, the collection's first key epoch
  is wrapped to it (`ensureFirstEpoch`), and the pws-client encrypts on write
  and decrypts on read: resources are JWE envelopes (XChaCha20-Poly1305
  content, per-recipient ECDH-ES+A256KW), `/meta` customs are encrypted the
  same way, and encrypted collections mint opaque resource ids (`add()`)
  rather than taking a name. Deleting out of an encrypted collection
  re-encrypts the body into `Trash` under `Trash`'s own epoch before the
  permanent delete. Only the account's user key can decrypt, and whichever
  credential opened the session unwrapped it. The client is
  `@interop/pws-client` 0.106 (the renamed was-client), which speaks PWS v0.5 and reads the server's
  service description before its first request.
- **Sharing** (`src/components/ShareCredentialModal.tsx`): before any share,
  the credential is verified with
  [`@digitalcredentials/verifier-core`](https://github.com/digitalcredentials/verifier-core)
  and problems are shown as warnings (sharing is never blocked). Because an
  encrypted credential's stored form is ciphertext, **Create Public Link**
  writes a plaintext copy of it into the space's `public` collection (a
  plaintext collection; the copy is named `<collection>--<id>`) and marks only
  that copy world-readable (`setPublic()`), then shows the copy's URL and a
  [VerifierPlus](https://verifierplus.org) link. **Unshare** clears the
  policy and deletes the copy (and its `Trash` remnant). **QR code** renders
  either link; a private credential is public only while the QR shows. **Add to LinkedIn**
  (`src/lib/linkedin.ts`) opens LinkedIn's add-to-profile form prefilled from
  the credential. The device share sheet appears where the Web Share API
  exists.
- **Add Credential** (`src/components/UploadCredentialModal.tsx`): paste JSON,
  pick or drag a file, scan a QR code with the camera, or drop a QR image. A
  QR may carry the credential JSON itself, a URL that serves it, or a CBOR-LD
  presentation in the `VP1-` format the LCW mobile wallet emits (decoded with
  [`@digitalcredentials/vpqr`](https://www.npmjs.com/package/@digitalcredentials/vpqr));
  see `src/lib/scan.ts`. Every path stages into the same editable fields, and
  a [vanilla-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)
  wrapper (`src/components/JSONInput.tsx`) checks and highlights JSON errors
  as you type.
- **Download my data** (`src/lib/exportWallet.ts`, `src/lib/dataExport.ts`,
  `src/lib/tar.ts`, the dialog in `src/components/ExportDataModal.tsx`):
  **Settings → Download my data** saves every document in every space the
  session reaches (all of them under a passkey, the account Space alone
  under a password) to one plain tar, a folder per space (its name, or its id) and a
  folder per collection inside it, each document under its resource id with
  a `manifest.json` first (the spaces, collections and counts, and any
  document left out). Each space is read through the PWS server's Export
  Space operation (`POST /space/{id}/export`, the pws-client's
  `space.export()`), which answers the Space as a Space archive; the wallet
  reads the archive with `@interop/space-archive` and decrypts each
  encrypted collection's envelopes with the user key and the collection's
  key-epoch descriptor from the archive (`createEdvDocCipher`), so no
  document is fetched one by one. The `id`, `account`, `dids` and `public`
  collections are left out (the account's own records and keys, and the
  public copies of shared credentials); `Trash` is included. The documents
  in the file are not encrypted, which the dialog says before the download.
- **CHAPI** (`src/chapi/`, `src/lib/claim.ts`, `src/lib/present.ts`,
  `src/lib/chapi.ts`): **Settings → Enable browser wallet** registers the
  wallet with the [authn.io](https://authn.io) mediator (a once-per-session
  prompt also offers it when the wallet opens unregistered). When an issuer
  page offers a credential, the mediator opens `chapi.html` (a second Vite
  entry rendering `src/chapi/ChapiPage.tsx`), which runs the
  [VC API exchange](https://www.w3.org/TR/vcalm-1.0/#workflows-and-exchanges):
  the holder DID is chosen from the issuer's `acceptedMethods`
  (`src/lib/identity/holder.ts`): the account's `did:webvh` when accepted,
  else its `did:web` projection (`did:web:{id domain}:{space id}`, the same
  document published as `id/did.json` beside the log and served by the
  identity domain, which any did:web resolver reads), else a fresh `did:key`
  stored in the space's encrypted `dids` collection. The session's key signs
  the DIDAuth presentation for an account DID, and later any credential of
  the account can present what was bound to it; a `did:key` credential is
  presented with its stored key. The issued credential is saved to a
  collection the user picks from every credential space of the account
  (grouped by space; `Trash`, `dids` and `public` excluded), or to a new
  collection created on the spot in the chosen space. An incoming
  **verifiable presentation request** from a verifier site shows what is being
  asked for, lets the user pick credentials, verifies them first (warn-only),
  and answers with a signed presentation. The companion issuer lives in
  [aws-lambda-issuer](https://github.com/digitalcredentials/aws-lambda-issuer).
- **Plugins** (`src/plugins/`): a plugin is a React component, bundled into
  the wallet from an npm package or a repository's `release` branch, that receives a
  `WalletHost` object (session WAS client, spaces API, service base URLs,
  `onUnauthorized`) and nothing else. `src/plugins/index.ts` lists the
  registered plugins; `App.tsx` generates a route for each plugin's page
  and `AppShell` a sidebar link for each page that wants one, rendered
  through `src/pages/PluginPage.tsx`. A plugin can instead, or also, fill
  the verification panel of the credential detail view
  (`slots.credentialDetail`); one with no page has no route or sidebar
  entry. [docs/plugins.md](docs/plugins.md) is the
  guide for plugin authors and for registering a plugin here: the host
  interface, the package shape, distribution (npm or a `release` branch),
  and the registry entry.
- **Credential Issuer** (`src/plugins/batchIssuerPlugin.ts`, `BatchIssuer.tsx`): the
  [batch-issuer-ui](https://github.com/digitalcredentials/batch-issuer-ui)
  panel as a plugin — its adapter is the host plus the issuer's `POST /notify`
  and per-credential revocation against the
  [status list service](https://github.com/digitalcredentials/status-list-lambda).
  The package is installed from that repository's `release` branch
  (`github:digitalcredentials/batch-issuer-ui#release`), which its workflow
  rebuilds on every push to `main`; the lock file pins the commit. To take a
  new build: `npm update @digitalcredentials/batch-issuer-ui`, then commit
  the lock file.
- **Verifier** (`src/plugins/verifierPlugin.ts`, `Verifier.tsx`): the
  [verifier-plugin](https://github.com/digitalcredentials/verifier-plugin)
  `<verifier-credential>` card in the verification panel of the credential
  detail view; no page, so no sidebar link. Installed the same way, from
  `github:digitalcredentials/verifier-plugin#release`, updated with
  `npm update @digitalcredentials/verifier-plugin`. `Verifier.tsx` looks
  issuers up in DCC's list of known registries, the same list the pre-share
  check uses (`src/lib/verify.ts`), and tells the card when that list didn't
  load rather than letting it fall back to its own default. Four registries
  on that list don't yet let a browser read them (dcc-members-oidf#65 and
  Credential Engine's), so an issuer found on none of the readable ones, such
  as a batch issuer's per-batch DID, verifies but reads "We couldn't confirm
  who issued this": some of the lists didn't respond. Once those registries
  are readable, an issuer on no list reads "Genuine, but we can't confirm who
  issued it".

Gotchas documented in the code and worth knowing: the verification section is
always rendered and hidden with CSS outside the detail view, so the plugin
components in it are never remounted; CHAPI calls go through
`navigator.credentialsPolyfill` rather
than `navigator.credentials`, which password managers like 1Password can lock;
and the handler page uses `WebCredentialHandler.activateHandler({get})` — not
`receiveCredentialEvent()`, which only serves the redirect pattern and times
out under the normal mediator flow.

## Local development

```bash
npm install
npm run dev
```

`.env` points the app at the local back end; `.env.production` carries the
deployed URLs (`VITE_API_BASE_URL` for lcw-back-end, `VITE_WAS_BASE_URL` for
the WAS server's `/spaces`, `VITE_TEMPLATES_API_BASE`, `VITE_ISSUER_API_BASE`
for the test issuer that grants the welcome credential, `VITE_BATCH_API_BASE`
for the batch issuer's notify endpoint, and `VITE_STATUS_API_BASE` for the
status list service). The full local stack
is:

- **lcw-back-end** `sam local start-api --port 3001 ...` — the login API
- **was-server-aws** `sam local start-api` (port 3000) — the spaces
- a demo account registered through the wallet against those two, so its
  Main Space and unlock space exist on the local PWS server

## Tests

```bash
npm run lint
npx playwright test tests/vp-request.spec.ts tests/verify-interpret.spec.ts tests/data-export.spec.ts
```

Lint (oxlint) and the unit specs that need no server: parsing and matching
of verifiable presentation requests (`src/lib/vpRequest.ts`), the
interpretation of verifier-core results for the pre-share check
(`src/lib/verify.ts`), and the data export's tar writer, Space archive
reader and layout (`src/lib/tar.ts`, `src/lib/dataExport.ts`).

```bash
npm run test:e2e
```

End-to-end Playwright tests against the local stack (see the prerequisites at
the top of `tests/e2e.spec.ts`): login, browsing, adding credentials (file,
paste, drag, and QR images carrying JSON, a URL, or a CBOR-LD `VP1-`
payload), verification, source view, public links with the VerifierPlus
companion link, the unshare confirmation round trip, QR sharing with
temporary public access, and the delete round trip into `Trash`. The Vite
dev server is started or reused automatically. Note: if the share test fails
mid-flow it can leave the demo credential public, which cascades into later
runs — clear `policies/UniversityOfToronto/LCWExperience.json.json` from the
demo space bucket to reset.

```bash
npm run test:claim
```

Drives the wallet side of the CHAPI claim (exchange, DIDAuth, saving the
issued credential) against the deployed issuer without a browser or the
mediator.

```bash
DEPLOYED_URL=https://lcw-sandbox.org npx playwright test tests/deployed.spec.ts
```

Opt-in smoke tests against a deployed instance: login and the space
collections, opening and verifying a credential, the batch issuer screen,
sharing to LinkedIn, the My Spaces and title navigation resets, the
welcome-credential dialog, creating, saving and deleting a batch (a
scratch batch space, under a passkey session), the sign-in credentials
page, a passkey added at sign-in that keeps the browser signed in until it
is forgotten (a virtual authenticator with the PRF extension, through the
Chrome DevTools Protocol), the phone layout, and the data download (the tar
is read back and the demo credential found decrypted in it) — with console
errors and failed requests captured for debugging. Skipped unless
`DEPLOYED_URL` is set. Run it after every deploy.

The demo account these tests sign in as (`jc.chartrand@gmail.com`, the
passphrase in the spec file) is registered by `npm run register:demo`
(`DEMO_EMAIL=... REGISTRATION_CODE=...`), which runs the wallet's own
registration from the shell; its confirmation email still has to be clicked.
Its Main Space is then seeded by `npm run seed:demo` (`DEMO_EMAIL=...`): an
encrypted `UniversityOfToronto` collection holding the LCW Experience Badge
fixture, created the way the wallet creates collections. Both scripts run the
identity layer under `tsx`, and both are idempotent. `npm run test:identity`
(`WAS_URL=... COUPON=...`, or `WAS_URL=... PROVISIONING=open` against a
server that creates Spaces by id) exercises the identity layer against a
PWS server without the back end: signup, the transient login, a passkey
credential added from it, the remembered logins, recovery codes from both
session kinds, and the passphrase again. The account it creates is left
behind. `npm run test:recovery` (`DEMO_EMAIL=...`) runs account recovery
against the deployed back end on the demo account: it issues a code,
recovers with it under a new passphrase, checks that the demo passphrase
still signs in, and leaves a replacement code stored. Each run adds a
passphrase credential to the account. `npm run test:credentials`
(`DEMO_EMAIL=...`) lists the demo account's sign-in methods, adds a
stand-in passkey credential, signs in with it as a remembered client and
lists the methods again; the passkey stays listed. Each run adds one.
`npm run test:holder` (`DEMO_EMAIL=...`) claims a badge from the deployed
test issuer as the demo account's `did:web` projection, checking the
projection the identity domain serves, the issuer's `acceptedMethods`, and
that the issued credential is bound to the account DID; nothing is stored.

## Deploy

The site is served at [https://lcw-sandbox.org](https://lcw-sandbox.org)
from the `dcc-lcw-ui` S3 bucket behind CloudFront (distribution
`E6VT0O094YUC1`; the `dk59u8ewdxjcs.cloudfront.net` domain still works).
`npm run build` bakes in the deployed service URLs from `.env.production`
(local dev keeps using `.env`). The batch issuer panel is installed from its
repository's `release` branch, so nothing is built outside this repo.

```bash
npm run build
aws s3 sync dist/ s3://dcc-lcw-ui/ --delete
# The HTML shells must never be cached: --delete removes old hashed chunks, so
# a stale cached index.html/chapi.html would reference chunks that now 404.
# CloudFront also serves these two paths with the CachingDisabled policy.
for f in index.html chapi.html; do
  aws s3 cp "s3://dcc-lcw-ui/$f" "s3://dcc-lcw-ui/$f" --metadata-directive REPLACE \
    --cache-control "no-store, must-revalidate" --content-type text/html
done
aws cloudfront create-invalidation --distribution-id E6VT0O094YUC1 --paths "/*"
```

CloudFront (`E6VT0O094YUC1`, Free plan → max 5 cache behaviors) carries three
non-default behaviors: `/manifest.json` (CORS for CHAPI, via S3 bucket CORS +
the managed CORS-S3Origin origin-request policy + CachingDisabled) and
`/chapi.html` + `/index.html` (CachingDisabled, so the shells are always
fresh). This config lives only on the live distribution, not in IaC.
