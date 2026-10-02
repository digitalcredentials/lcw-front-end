# lcw-front-end

The web front end for the Learner Credential Wallet (LCW): a React + TypeScript
+ Vite app for logging in with a passphrase-derived
[did:key](https://w3c-ccg.github.io/did-key-spec/), browsing the account's
[Wallet Attached Storage](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
spaces, adding, viewing, sharing, moving, deleting, and verifying Verifiable
Credentials, claiming and presenting them over [CHAPI](https://chapi.io/), and
issuing batches of credentials through the embedded
[batch-issuer-ui](https://github.com/digitalcredentials/batch-issuer-ui) panel.

## How it works

- **Login** (`src/lib/login.ts`): the password is the seed — SHA-256 of it is
  the Ed25519 key, so the same password always derives the same `did:key`. The
  page signs a [zCap capability invocation](https://github.com/interop-alliance/http-signature-zcap-verify)
  of the lcw-back-end's `POST /login`, which verifies it against the DID
  registered for the email and returns the account's registration token (the
  WAS server's space-creation coupon) and its spaces. The key pair, controller
  DID, email, coupon, and credential-space URL are kept in `localStorage` for
  the session (cleared on sign-out). On the first open after registering, the
  wallet offers to issue a **welcome credential** (the test issuer's LCW
  Sandbox Badge) and, in the same flow, to enable the browser wallet
  (`src/lib/welcome.ts`, the dialog in `src/components/AppShell.tsx`).
- **My Spaces** (`src/pages/SpaceBrowserPage.tsx`, `src/lib/spaces.ts`): the
  account's spaces as cards, with names and descriptions read from each
  space's WAS description document. **New Space** provisions a space through
  the WAS server's spec-shaped `POST /spaces` (controller DID + coupon);
  renaming and describing a space edits its description document; a `batch`
  space's card asks whether to open the batch view or the standard space view.
- **Space browser**: a space's collections and resources through
  [`@interop/was-client`](https://www.npmjs.com/package/@interop/was-client),
  signing every request with the login key. Collections and credentials are
  cards; opening a credential shows a formatted summary with its source and a
  live verification (the [veri-good](https://github.com/digitalcredentials/veri-good)
  web component) side by side, plus **Share**, **Move** (between
  collections), and **Delete** (soft delete into the space's `Trash`
  collection, from which **Restore** moves it back out).
- **Sharing** (`src/components/ShareCredentialModal.tsx`): before any share,
  the credential is verified with
  [`@digitalcredentials/verifier-core`](https://github.com/digitalcredentials/verifier-core)
  and problems are shown as warnings (sharing is never blocked). **Create
  Public Link** marks just that credential world-readable
  (`resource.setPublic()`; its collection and siblings stay private) and shows
  the raw credential URL and a [VerifierPlus](https://verifierplus.org) link.
  **Unshare** clears the policy. **QR code** renders either link; a private
  credential is public only while the QR shows. **Add to LinkedIn**
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
- **CHAPI** (`src/chapi/`, `src/lib/claim.ts`, `src/lib/present.ts`,
  `src/lib/chapi.ts`): **Settings → Enable browser wallet** registers the
  wallet with the [authn.io](https://authn.io) mediator (a once-per-session
  prompt also offers it when the wallet opens unregistered). When an issuer
  page offers a credential, the mediator opens `chapi.html` (a second Vite
  entry rendering `src/chapi/ChapiPage.tsx`), which runs the
  [VC API exchange](https://www.w3.org/TR/vcalm-1.0/#workflows-and-exchanges):
  a fresh `did:key` (stored in the space's `dids` collection) signs the
  DIDAuth presentation, and the issued credential is saved to a collection the
  user picks (including a new one created on the spot). An incoming
  **verifiable presentation request** from a verifier site shows what is being
  asked for, lets the user pick credentials, verifies them first (warn-only),
  and answers with a signed presentation. The companion issuer lives in
  [aws-lambda-issuer](https://github.com/digitalcredentials/aws-lambda-issuer).
- **Credential Issuer** (`src/pages/BatchIssuerPage.tsx`): mounts the
  [batch-issuer-ui](https://github.com/digitalcredentials/batch-issuer-ui)
  panel with an adapter built from the wallet's own session — the WAS client,
  the spaces API, the issuer's `POST /notify`, and per-credential revocation
  against the [status list service](https://github.com/digitalcredentials/status-list-lambda).

Gotchas documented in the code and worth knowing: veri-good's issuer list must
be set via `setIssuerDids()` (React never populates a `<template>` child's
`.content`); the `<veri-good>` element is mounted once and hidden with CSS,
never remounted; CHAPI calls go through `navigator.credentialsPolyfill` rather
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
the WAS server's `/spaces`, `VITE_TEMPLATES_API_BASE`, `VITE_ISSUER_API_BASE`,
and `VITE_STATUS_API_BASE` for the status list service). The full local stack
is:

- **lcw-back-end** `sam local start-api --port 3001 ...` — the login API
- **was-server-aws** `sam local start-api` (port 3000) — the spaces
- a demo account registered in the `wallet-test` DynamoDB table with a space
  registered under `http://localhost:3000` in `wallet-spaces`

## Tests

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
sharing to LinkedIn, the My Spaces and title navigation resets, and the
welcome-credential dialog — with console errors and failed requests captured
for debugging. Skipped unless `DEPLOYED_URL` is set.

## Deploy

The site is served at [https://lcw-sandbox.org](https://lcw-sandbox.org)
from the `dcc-lcw-ui` S3 bucket behind CloudFront (distribution
`E6VT0O094YUC1`; the `dk59u8ewdxjcs.cloudfront.net` domain still works).
`npm run build` bakes in the deployed lcw-back-end API URL from
`.env.production` (local dev keeps using `.env`).

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
