import type { ComponentType } from 'react';
import type { WasClient } from '@interop/was-client';
import type { SpaceInfo } from '../lib/spaces';

// What the wallet supplies to every plugin. A plugin is a React component
// bundled into the wallet (a published npm package, or a file in this repo)
// that receives this host object and nothing else: no env vars, no storage,
// no login flow. Capabilities a single plugin needs beyond these are wired in
// that plugin's registry entry (see batchIssuerPlugin.ts), not added here.
export interface WalletHost {
  // The signed-in session's WAS client; null when the session is gone.
  getSession(): Promise<{ client: WasClient } | null>;
  // The WAS server's /spaces API, authenticated as the session's DID.
  spaces: {
    create(type: 'credential' | 'batch', name: string): Promise<string>;
    list(): Promise<SpaceInfo[]>;
    remove(spaceUrl: string): Promise<void>;
  };
  // Base URLs of the deployed services (trailing slash removed).
  statusApiBase: string;
  templatesApiBase: string;
  // Called when a WAS or back-end call is rejected as unauthorized; the
  // wallet clears the session and returns to the login page.
  onUnauthorized(): void;
}

// A plugin's own page: a route the wallet generates, rendered inside
// AppShell behind RequireAuth (so the component may use the router like any
// wallet page), with a link in the left sidebar unless `menu` is false.
export interface WalletPluginPage {
  // Route path, e.g. '/batches'. Also the sidebar link target.
  path: string;
  // Sidebar link tooltip.
  description?: string;
  // Whether the sidebar links to the page (default true). A page reached
  // only by navigation from elsewhere sets this false.
  menu?: boolean;
  Component: ComponentType<{ host: WalletHost }>;
}

// A registry entry. A plugin contributes a page, slots in the wallet's own
// pages, or both; one with no `page` has no route and no sidebar link (a
// verifier that appears only in the credential detail view, say).
export interface WalletPlugin {
  // Unique among registered plugins; the React key.
  id: string;
  // The plugin's name: the sidebar label of its page, and how the wallet
  // refers to it elsewhere.
  title: string;
  page?: WalletPluginPage;
  // Components the plugin contributes to fixed places in the wallet's own
  // pages. Each slot is rendered for every plugin that fills it, in registry
  // order.
  slots?: {
    // The verification panel of the credential detail view. `credential` is
    // the stored credential with its presentation envelope removed; null
    // when the stored resource is not a credential.
    credentialDetail?: ComponentType<{
      credential: Record<string, unknown> | null;
      host: WalletHost;
    }>;
  };
}
