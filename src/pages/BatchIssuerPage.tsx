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
