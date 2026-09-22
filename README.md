# lcw-front-end

The web front end for the Learner Credential Wallet (LCW): a React + TypeScript
+ Vite app for logging in with a passphrase-derived
[did:key](https://w3c-ccg.github.io/did-key-spec/), browsing the account's
[Wallet Attached Storage](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
space, and adding, viewing, sharing, deleting, verifying, and claiming
Verifiable Credentials — including claiming over
[CHAPI](https://chapi.io/) from an external issuer.

## How it works

- **Login** (`src/lib/login.ts`): the password is the seed — SHA-256 of it is
  the Ed25519 key, so the same password always derives the same `did:key`. The
  page signs a [zCap capability invocation](https://github.com/interop-alliance/http-signature-zcap-verify)
  of the lcw-back-end's `POST /login`, which verifies it against the DID
  registered for the email and returns the account's space URL. The key pair,
  controller DID, and space URL are kept in `localStorage` for the session
  (cleared on sign-out).
- **Space browser** (`src/pages/SpaceBrowserPage.tsx`): lists the space's
  collections and resources through
  [`@interop/was-client`](https://www.npmjs.com/package/@interop/was-client),
  signing every request with the login key. Each credential row offers
  **Verify** (opens it in the [veri-good](https://github.com/digitalcredentials/veri-good)
  web component below the browser), **View Source** (read-only JSON editor),
  **Share**, and **Delete** (soft delete into the space's `Trash` collection).
- **Sharing** (`src/components/ShareCredentialModal.tsx`): **Create Public
  Link** marks just that credential world-readable (`resource.setPublic()`;
  its collection and siblings stay private) and shows two links — the raw
  credential URL and a [VerifierPlus](https://verifierplus.org) link that
  renders it verified. **Unshare** (with a confirmation warning) clears the
  policy. **QR code** renders either link as a scannable code; a private
  credential is made public only while the QR is showing and reverts when it's
  hidden or the dialog closes. The device share sheet appears where the Web
  Share API exists; LinkedIn is still a stub.
- **Add Credential** (`src/components/UploadCredentialModal.tsx`): paste JSON,
  pick or drag a file, scan a QR code with the camera, or drop a QR image. A
  QR may carry the credential JSON itself, a URL that serves it, or a CBOR-LD
  presentation in the `VP1-` format the LCW mobile wallet emits (decoded with
  [`@digitalcredentials/vpqr`](https://www.npmjs.com/package/@digitalcredentials/vpqr));
  see `src/lib/scan.ts`. Every path stages into the same editable fields, and
  a [vanilla-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)
  wrapper (`src/components/JSONInput.tsx`) checks and highlights JSON errors
  as you type.
- **Claiming over CHAPI** (`src/chapi/`, `src/lib/claim.ts`,
  `src/lib/chapi.ts`): the header's **Enable browser wallet** button registers
  the wallet with the [authn.io](https://authn.io) mediator (the button
  reflects the real permission state and offers to disable). When an issuer
  page requests a credential exchange, the mediator opens `chapi.html` (a
  second Vite entry rendering `src/chapi/ChapiPage.tsx`), which runs the
  [VC API exchange](https://www.w3.org/TR/vcalm-1.0/#workflows-and-exchanges):
  it generates a fresh `did:key`, stores it (with its secret) in the space's
  `dids` collection, signs the DIDAuth presentation over the issuer's
  challenge and domain, and saves the issued credential to a collection the
  user picks. The companion issuer lives in
  [aws-lambda-issuer](https://github.com/digitalcredentials/aws-lambda-issuer).

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

`.env` points the app at the local back end. The full local stack is:

- **lcw-back-end** `sam local start-api --port 3001 ...` — the login API
- **was-server-aws** `sam local start-api` (port 3000) — the space
- a demo account registered in the `wallet-test` DynamoDB table whose
  `spaceURL` points at `http://localhost:3000`

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

Opt-in smoke tests against a deployed instance (login as the deployed demo
account, list the space, verify a credential), with console errors and failed
requests captured for debugging. Skipped unless `DEPLOYED_URL` is set.

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
