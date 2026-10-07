import { batchIssuerPlugin } from './batchIssuerPlugin';
import type { WalletPlugin } from './types';

// The plugins mounted in this wallet build. App.tsx generates a route for
// each and AppShell a sidebar link, in this order. To add a plugin: install
// its package, write a registry entry like batchIssuerPlugin.ts that maps the
// WalletHost onto the plugin's own adapter, and append it here. A plugin
// whose JSX carries Tailwind classes also needs an @source line in
// src/index.css so those classes are compiled.
export const plugins: WalletPlugin[] = [batchIssuerPlugin];

export type { WalletHost, WalletPlugin } from './types';
export { useWalletHost } from './host';
