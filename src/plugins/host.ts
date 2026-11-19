import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearToken } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
import type { WalletHost } from './types';

// Builds the host object handed to plugins from the wallet's own session.
// Memoized per navigate so a plugin's props stay stable across renders.
export function useWalletHost(): WalletHost {
  const navigate = useNavigate();
  return useMemo<WalletHost>(
    () => ({
      getSession: getSessionWASClient,
      onUnauthorized: () => {
        clearToken();
        navigate('/login', { replace: true });
      },
    }),
    [navigate]
  );
}
