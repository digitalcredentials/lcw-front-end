import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { BatchIssuerPanel, type BatchIssuerAdapter } from '@digitalcredentials/batch-issuer-ui';
import { notifyRecipients } from '../lib/notify';
import type { WalletHost } from './types';

// The @digitalcredentials/batch-issuer-ui panel as a wallet plugin. Its
// adapter is the host plus the two batch-specific calls the panel needs: the
// issuer's POST /notify and the status list service's POST /revoke.
export default function BatchIssuer({ host }: { host: WalletHost }) {
  // The spaces view navigates here with a batch space's URL in the route
  // state when the user chooses to open that space in the batch view; the
  // panel then opens straight into that batch.
  const { state } = useLocation();
  const initialSpaceUrl = (state as { spaceUrl?: string } | null)?.spaceUrl;

  const adapter = useMemo<BatchIssuerAdapter>(
    () => ({
      getSession: host.getSession,
      spaces: host.spaces,
      notifyRecipients,
      // The revocation token is the authorization, so this talks to the
      // status service directly.
      revokeStatus: async (revocationToken: string) => {
        const response = await fetch(`${host.statusApiBase}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revocationToken }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? 'The revocation failed.');
        }
      },
      templatesApiBase: host.templatesApiBase,
      onUnauthorized: host.onUnauthorized,
    }),
    [host]
  );

  return <BatchIssuerPanel adapter={adapter} initialSpaceUrl={initialSpaceUrl} />;
}
