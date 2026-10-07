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

// A registry entry: the wallet generates one route and one sidebar link from
// each. Pages render inside AppShell behind RequireAuth, so the component may
// use the router (useLocation/useNavigate) like any wallet page.
export interface WalletPlugin {
  // Route path, e.g. '/batches'. Also the sidebar link target.
  path: string;
  // Sidebar label.
  title: string;
  // Sidebar link tooltip.
  description?: string;
  Component: ComponentType<{ host: WalletHost }>;
  // Components the plugin contributes to fixed places in the wallet's own
  // pages, besides its page. Each slot is rendered for every plugin that
  // fills it, in registry order.
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
