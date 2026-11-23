import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../../src/components/AppShell';

// Test-only: renders the signed-in layout (sidebar and all) on its own, so
// tests/feedback-link.spec.ts can check its links in the dev server's page
// without a signed-in session. The dev server serves this file; the app
// never imports it.
export function show() {
  const host = document.createElement('div');
  host.id = 'shell-harness';
  document.body.append(host);
  flushSync(() =>
    createRoot(host).render(
      <MemoryRouter initialEntries={['/files']}>
        <AppShell>
          <p>Page</p>
        </AppShell>
      </MemoryRouter>
    )
  );
}
