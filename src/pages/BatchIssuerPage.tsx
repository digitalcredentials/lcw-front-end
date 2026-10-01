import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
      <BatchIssuerPanel adapter={adapter} />
    </AppShell>
  );
}
