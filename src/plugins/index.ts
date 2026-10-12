import { batchIssuerPlugin } from './batchIssuerPlugin';
import { verifierPlugin } from './verifierPlugin';
import type { WalletPlugin } from './types';

// The plugins mounted in this wallet build, in sidebar order. App.tsx
// generates a route for each plugin page and AppShell a sidebar link for
// each page that wants one; the credential detail view renders every
// credentialDetail slot. To add a plugin: install its package, write a
// registry entry like batchIssuerPlugin.ts that maps the WalletHost onto
// the plugin's own adapter, and append it here. A plugin whose JSX carries
// Tailwind classes also needs an @source line in src/index.css so those
// classes are compiled.
export const plugins: WalletPlugin[] = [batchIssuerPlugin, verifierPlugin];

// The pages the plugins contribute, with their plugin.
export const pluginPages = plugins.flatMap((plugin) =>
  plugin.page ? [{ plugin, page: plugin.page }] : []
);

export type { WalletHost, WalletPlugin, WalletPluginPage } from './types';
export { useWalletHost } from './host';
