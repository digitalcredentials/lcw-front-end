import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BatchIssuerPanel, type BatchIssuerAdapter } from '@digitalcredentials/batch-issuer-ui';
import { clearToken } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-semibold text-gray-800">Batch issuer</span>
        <Link to="/files" className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
          Back to my space
        </Link>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8">
        <BatchIssuerPanel adapter={adapter} />
      </main>
    </div>
  );
}
