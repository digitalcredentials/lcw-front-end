# Wallet plugins

How a package becomes part of this wallet, written for whoever builds the
package — a person or an AI agent — and for whoever registers it here.

The wallet is thin. Features such as issuing credentials, verifying them,
sharing them, or showing QR codes are plugins: separate packages that the
wallet bundles at build time and mounts in fixed places. This document states
what the wallet supplies, what a plugin package must look like, how it is
distributed, and what is added to the wallet to register it.

The source of truth for the types quoted here is
[`src/plugins/types.ts`](../src/plugins/types.ts). If this document and that
file disagree, the file is right.

## 1. What a plugin is

A plugin is a **React component** bundled into the wallet's build. The wallet
renders it and passes one prop, `host`, an object that gives it the signed-in
session and a few services. The plugin receives nothing else: it does not read
environment variables, `localStorage`, or the wallet's routes, and it does not
know how the user logged in.

A plugin can appear in two places. One registry entry can fill both.

| Place | What the wallet renders | Prop(s) |
|---|---|---|
| **Its own page**, with a link in the left sidebar (for example *Credential Issuer* at `/batches`) | `plugin.Component` inside the wallet's chrome, behind login | `host` |
| **The verification panel of the credential detail view** (the right-hand panel when a stored credential is opened) | `plugin.slots.credentialDetail`, in place of the wallet's built-in verifier | `credential`, `host` |

A plugin whose UI is a **web component** (a custom element) is fine: the
wallet wraps it in a small React component in the registry entry (section 5).
React 19 assigns object-valued JSX props to custom elements as DOM properties,
so `<my-element credential={object} />` works with no ref.

## 2. What the wallet supplies: `WalletHost`

```ts
import type { WasClient } from '@interop/was-client';

export interface WalletHost {
  // The signed-in session's WAS client; null when the session is gone.
  getSession(): Promise<{ client: WasClient } | null>;
  // The WAS server's /spaces API, authenticated as the session's DID.
  spaces: {
    create(type: 'credential' | 'batch', name: string): Promise<string>; // resolves to the new space URL
    list(): Promise<SpaceInfo[]>;   // { url, type, name?, createdAt? }
    remove(spaceUrl: string): Promise<void>;
  };
  // Base URLs of the deployed services (no trailing slash).
  statusApiBase: string;     // the status list service (POST /revoke, GET /{listId})
  templatesApiBase: string;  // the credential-templates API (GET /templates)
  // Call this when a WAS or back-end request is rejected as unauthorized;
  // the wallet clears the session and returns to the login page.
  onUnauthorized(): void;
}
```

Rules that follow from it:

- **Session.** Call `host.getSession()` when you need the WAS client; do not
  cache the client across user actions, because it is `null` once the session
  ends. Through it you reach the user's spaces and collections with the
  [`@interop/was-client`](https://www.npmjs.com/package/@interop/was-client)
  API (`client.space(id).collection(name).get/put/add/list…`). Collections
  the wallet created are end-to-end encrypted; the client decrypts and
  encrypts transparently, so a plugin reads and writes plain objects.
- **Errors.** When a WAS or back-end call is rejected as unauthorized
  (HTTP 401/403), call `host.onUnauthorized()` and stop. Show every other
  error in your own UI.
- **Configuration.** Anything host-specific that is not in `WalletHost` (an
  API key, a list of trust registries, a feature switch) is passed by the
  wallet's registry entry (section 5) as a prop or property of your
  component. Expose it as a prop; do not read it from the environment.
- **Nothing else.** No `import.meta.env`, no `window.localStorage`, no
  `react-router` imports in the package. If your page needs navigation state
  from the wallet (the batch issuer receives a space URL to open), the
  registry entry reads it and passes it as a prop.

The `credentialDetail` slot additionally receives:

```ts
credential: Record<string, unknown> | null
```

the stored credential with its presentation envelope removed (the
`verifiableCredential[0]` of a stored `{ verifiableCredential: [...] }`
document, or the document itself when it is a bare credential), or `null`
when the opened resource is not a credential. The slot component stays
mounted while the spaces page is open and is hidden with CSS when no
credential is open; `credential` is then `null`, and it changes whenever the
user opens another credential. Clear your previous result when it changes
or becomes `null`. Do not depend on staying mounted either: the page itself
unmounts when the user navigates away.

## 3. What the package must look like

The wallet is Vite 8, React 19, TypeScript 6, Tailwind CSS 4, ES modules.

**Build output.** One ES module entry (`dist/index.js`) with type
declarations (`dist/index.d.ts`), declared in `package.json`:

```json
{
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "LICENSE", "README.md"]
}
```

**Shared dependencies stay external.** The wallet already bundles React,
ReactDOM and `@interop/was-client`; a second copy of React breaks hooks, and
a second was-client cannot share the session. Declare them as
`peerDependencies` and mark them `external` in your bundler
(`rollupOptions.external: [/^react($|\/)/, /^react-dom($|\/)/, '@interop/was-client']`).
A library that nothing in the wallet shares — a verification library, a CSV
parser, a QR encoder — may be bundled in or listed as a regular dependency,
either works. If two copies of a library would be wrong (one of them holds
global state), bundle it in so the version is yours.

**Side effects.** If importing your package registers a custom element
(`customElements.define`) or does anything else on import, do **not** set
`"sideEffects": false`, or the bundler may drop the import. A pure React
component library may set it.

**Styling — pick one:**

1. *Tailwind class names in JSX, no CSS shipped* (the batch issuer). The
   wallet compiles them: the registry entry adds
   `@source "../node_modules/@digitalcredentials/<package>/dist";` to
   [`src/index.css`](../src/index.css). The plugin then shares the wallet's
   theme. Only works in a Tailwind host.
2. *A shadow root with its own styles* (web components). Self-contained, host
   independent. Expose CSS custom properties for colours and fonts so the
   wallet can match its palette by setting them on the element.
3. *A CSS file in `dist/`* that the registry entry imports.

**Web components additionally:**

- Set inputs as **properties** (the credential object, options), not
  attributes, since attributes are strings. Report results as DOM
  `CustomEvent`s on the element.
- Ship JSX typings so a React host does not write its own: a `.d.ts` in
  `dist/` that augments `React.JSX.IntrinsicElements` with your tag and its
  properties, re-exported from `index.d.ts`. Without it the wallet keeps a
  `src/types/<name>.d.ts`, which goes stale.
- Handle detach/reattach: React removes and re-inserts elements. Do work in
  `connectedCallback` (or defer it there when a property is set while
  detached), and never assume one mount per page load.

**Public surface.** Export the component (or register the element), the
props/adapter type, and nothing the wallet does not need. Document in your
README the registry entry the wallet should contain (section 5), including
any configuration prop.

## 4. How the wallet gets the package

One of these; the wallet's `package.json` names which. Every plugin, from its first integration, is taken from a published package or a `release` branch, so that a wallet build never depends on a checkout on someone's machine.

| Method | `package.json` entry | When |
|---|---|---|
| **npm** | `"@scope/name": "^1.2.3"` | the package is published |
| **GitHub release branch** (current practice) | `"@scope/name": "github:org/repo#release"` | the package is not published yet. A workflow in the plugin repo builds `dist/` on every push to `main` and force-pushes it with `package.json`, `LICENSE` and `README.md` to a `release` branch. `npm install` clones that branch and runs none of the package's scripts, so the wallet needs none of the plugin's build tools. The wallet's lock file pins the commit; `npm update @scope/name` moves it. Reference implementation: [batch-issuer-ui `.github/workflows/release.yml`](https://github.com/digitalcredentials/batch-issuer-ui/blob/main/.github/workflows/release.yml) (a build job with a read-only token, a publish job that installs nothing). |

Do not rely on a `prepare` script that builds on install: it makes every
wallet `npm install` run the plugin's toolchain, and fails on machines
without it.

## 5. Registering a plugin in the wallet

One file per plugin in [`src/plugins/`](../src/plugins/), plus one line in
[`src/plugins/index.ts`](../src/plugins/index.ts). The entry maps
`WalletHost` onto whatever the package expects and carries any host-specific
configuration. The wallet generates the route, the sidebar link and the
detail-view slot from the entry; nothing else in the wallet changes.

```ts
export interface WalletPlugin {
  path: string;          // route and sidebar link target, e.g. '/verify'
  title: string;         // sidebar label
  description?: string;  // sidebar link tooltip
  Component: ComponentType<{ host: WalletHost }>;
  slots?: {
    credentialDetail?: ComponentType<{ credential: Record<string, unknown> | null; host: WalletHost }>;
  };
}
```

Example — a React-component plugin with its own adapter (the batch issuer,
[`src/plugins/batchIssuerPlugin.ts`](../src/plugins/batchIssuerPlugin.ts) and
[`BatchIssuer.tsx`](../src/plugins/BatchIssuer.tsx)): the entry's component
builds the package's `BatchIssuerAdapter` from `host` plus two wallet-side
calls the panel needs and renders `<BatchIssuerPanel adapter={…} />`.

Example — a web-component plugin that fills both places:

```tsx
// src/plugins/Verifier.tsx
import { useState } from 'react';
import '@digitalcredentials/verifier-plugin'; // registers <verifier-credential>
import type { WalletHost } from './types';

const REGISTRIES = [{ name: 'DCC Sandbox Registry', type: 'dcc-legacy', url: 'https://…/registry.json' }];

// The credential detail slot: the card for the opened credential.
export function VerifierDetail({ credential }: { credential: Record<string, unknown> | null; host: WalletHost }) {
  return <verifier-credential credential={credential ?? undefined} registries={REGISTRIES} />;
}

// The sidebar page: the wallet supplies the credential source (paste, upload,
// or pick from the user's collections via host.getSession()), the plugin the card.
export default function VerifierPage({ host }: { host: WalletHost }) {
  const [credential, setCredential] = useState<Record<string, unknown>>();
  // … a chooser that calls setCredential …
  return <verifier-credential credential={credential} registries={REGISTRIES} />;
}
```

```ts
// src/plugins/verifierPlugin.ts
export const verifierPlugin: WalletPlugin = {
  path: '/verify',
  title: 'Verify',
  description: 'Check a credential',
  Component: VerifierPage,
  slots: { credentialDetail: VerifierDetail },
};
```

Then `plugins: WalletPlugin[] = [batchIssuerPlugin, verifierPlugin]` in
`index.ts`, the dependency in `package.json`, and (Tailwind plugins only) the
`@source` line in `src/index.css`.

## 6. Checklist for a plugin package

- [ ] ES module build at `dist/index.js` with `dist/index.d.ts`; `exports`
      and `files` set as in section 3.
- [ ] `react`, `react-dom` (and `@interop/was-client` if used) are
      `peerDependencies` and external in the bundle; everything else bundled
      or a regular dependency.
- [ ] No reads of `import.meta.env`, `localStorage`, or the router; all
      inputs arrive as props/properties; unauthorized errors reported through
      `host.onUnauthorized()` (or surfaced so the registry entry can).
- [ ] Styling by one of the three methods in section 3; a web component
      exposes CSS custom properties.
- [ ] Web components ship JSX typings, take objects as properties, emit
      events, and tolerate detach/reattach.
- [ ] `sideEffects` not set to `false` if the import registers anything.
- [ ] Distributed by npm or by a `release` branch built from `main` (the
      batch-issuer-ui workflow is the reference); no `prepare` build.
- [ ] README shows the wallet registry entry: the component(s), the props
      the wallet must pass, and any configuration.

## 7. Checklist for registering it here

- [ ] Dependency in `package.json` (npm version or `github:…#release`);
      lock file committed.
- [ ] `src/plugins/<name>Plugin.ts` (+ a `.tsx` wrapper when the package is
      a web component or needs wallet-side calls), appended to `plugins` in
      `src/plugins/index.ts`.
- [ ] `@source` line in `src/index.css` for Tailwind-class plugins.
- [ ] A deployed test in `tests/deployed.spec.ts` that opens the page (and
      the slot, if filled).
- [ ] README's plugin list updated.
