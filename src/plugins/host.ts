import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearToken } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
import { createSpace, listSpaces, deleteSpace } from '../lib/spaces';
import type { WalletHost } from './types';

const trimSlash = (url: string | undefined) => (url ?? '').replace(/\/+$/, '');

// Builds the host object handed to plugins from the wallet's own session and
// configuration. Memoized per navigate so a plugin's props stay stable across
// renders.
export function useWalletHost(): WalletHost {
  const navigate = useNavigate();
  return useMemo<WalletHost>(
    () => ({
      getSession: getSessionWASClient,
      spaces: {
        create: createSpace,
        list: listSpaces,
        remove: deleteSpace,
      },
      statusApiBase: trimSlash(import.meta.env.VITE_STATUS_API_BASE),
      templatesApiBase: trimSlash(import.meta.env.VITE_TEMPLATES_API_BASE),
      onUnauthorized: () => {
        clearToken();
        navigate('/login', { replace: true });
      },
    }),
    [navigate]
  );
}
