import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CredentialVerifier from '../../src/components/CredentialVerifier';

// Test-only: renders the wallet's CredentialVerifier on its own, so
// tests/verifier-plugin.spec.ts can drive it in the dev server's page without
// a signed-in session. The dev server serves this file; the app never imports it.
let root: Root | null = null;

export function show(credential?: Record<string, unknown>) {
  if (!root) {
    const host = document.createElement('div');
    host.id = 'verifier-harness';
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => root!.render(<CredentialVerifier credential={credential} />));
}
