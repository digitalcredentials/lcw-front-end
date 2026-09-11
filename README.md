# lcw-front-end

The web front end for the Learner Credential Wallet (LCW): a React + TypeScript
+ Vite app for logging in with a passphrase-derived
[did:key](https://w3c-ccg.github.io/did-key-spec/), browsing the account's
[Wallet Attached Storage](https://w3c-ccg.github.io/wallet-attached-storage-spec/)
space, and uploading, viewing, sharing, deleting, and verifying Verifiable
Credentials.

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
  **Share** (stubbed options plus the device share sheet), and **Delete**
  (soft delete into the space's `Trash` collection).
- **Uploads** (`src/components/UploadCredentialModal.tsx`): paste JSON, pick a
  file, or drag one in; a [vanilla-jsoneditor](https://github.com/josdejong/svelte-jsoneditor)
  wrapper (`src/components/JSONInput.tsx`) checks and highlights JSON errors as
  you type.

Two gotchas are documented in the code and worth knowing: veri-good's issuer
list must be set via `setIssuerDids()` (React never populates a `<template>`
child's `.content`), and the `<veri-good>` element is mounted once and hidden
with CSS, never remounted.

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
the top of `tests/e2e.spec.ts`): login, browsing, all three upload modes,
verification, source view, share options, and the delete round trip into
`Trash`. The Vite dev server is started or reused automatically.

```bash
DEPLOYED_URL=https://lcw-sandbox.org npx playwright test tests/deployed.spec.ts
```

Opt-in smoke tests against a deployed instance (login as the deployed demo
account, list the space, verify a credential), with console errors and failed
requests captured for debugging. Skipped unless `DEPLOYED_URL` is set.

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Deploy

The site is served at [https://lcw-sandbox.org](https://lcw-sandbox.org)
from the `dcc-lcw-ui` S3 bucket behind CloudFront (distribution
`E6VT0O094YUC1`; the `dk59u8ewdxjcs.cloudfront.net` domain still works).
`npm run build` bakes in the deployed lcw-back-end API URL from
`.env.production` (local dev keeps using `.env`).

```bash
npm run build
aws s3 sync dist/ s3://dcc-lcw-ui/ --delete
aws cloudfront create-invalidation --distribution-id E6VT0O094YUC1 --paths "/*"
```
