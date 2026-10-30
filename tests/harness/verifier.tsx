import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import VerifierDetail from '../../src/plugins/Verifier';
import type { WalletHost } from '../../src/plugins/types';

// Test-only: renders the verifier plugin's credentialDetail slot on its own, so
// tests/verifier-plugin.spec.ts can drive it in the dev server's page without a
// signed-in session. The dev server serves this file; the app never imports it.
// The slot doesn't use its host, so none is built.
let root: Root | null = null;

export function show(credential?: Record<string, unknown>) {
  if (!root) {
    const host = document.createElement('div');
    host.id = 'verifier-harness';
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => root!.render(<VerifierDetail credential={credential ?? null} host={{} as WalletHost} />));
}
