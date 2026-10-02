import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BatchIssuerPanel, type BatchIssuerAdapter } from '@digitalcredentials/batch-issuer-ui';
import { clearToken } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
import AppShell from '../components/AppShell';
import { createSpace, listSpaces, deleteSpace } from '../lib/spaces';
import { notifyRecipients } from '../lib/notify';

// The batch issuer screen: the @digitalcredentials/batch-issuer-ui panel
// mounted in the wallet's chrome, driven by the wallet's own session (WAS
// client + the back end's /spaces API).
export default function BatchIssuerPage() {
  const navigate = useNavigate();
  // The spaces view navigates here with a batch space's URL in the route
  // state when the user chooses to open that space in the batch view; the
  // panel then opens straight into that batch.
  const { state } = useLocation();
  const initialSpaceUrl = (state as { spaceUrl?: string } | null)?.spaceUrl;

  const adapter = useMemo<BatchIssuerAdapter>(
    () => ({
      getSession: getSessionWASClient,
      spaces: {
        create: createSpace,
        list: listSpaces,
        remove: deleteSpace,
      },
      notifyRecipients,
      // Revokes a credential's status position; the token is the
      // authorization, so this talks to the status service directly.
      revokeStatus: async (revocationToken: string) => {
        const base = (import.meta.env.VITE_STATUS_API_BASE ?? '').replace(/\/+$/, '');
        const response = await fetch(`${base}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revocationToken }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? 'The revocation failed.');
        }
      },
      templatesApiBase: (import.meta.env.VITE_TEMPLATES_API_BASE ?? '').replace(/\/+$/, ''),
      onUnauthorized: () => {
        clearToken();
        navigate('/login', { replace: true });
      },
    }),
    [navigate]
  );

  return (
    <AppShell>
      <BatchIssuerPanel adapter={adapter} initialSpaceUrl={initialSpaceUrl} />
    </AppShell>
  );
}
