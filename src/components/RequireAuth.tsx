import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { isAuthenticated } from '../lib/auth';
import { openWithBrowserCredential, setSession, storedBrowserCredential } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import LoadingLabel from './LoadingLabel';

interface Props {
  children: ReactNode;
}

// Guards the signed-in pages. With no session in this tab, a browser
// credential kept by "Stay signed in on this browser" opens the account
// first; only when there is none, or it no longer opens the account, does
// the page go to the login form.
export default function RequireAuth({ children }: Props) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>(() =>
    isAuthenticated() ? 'in' : storedBrowserCredential() ? 'checking' : 'out'
  );

  useEffect(() => {
    if (state !== 'checking') {
      return;
    }
    let cancelled = false;
    openWithBrowserCredential({ config: identityConfig() })
      .then((opened) => {
        if (cancelled) {
          return;
        }
        if (opened) {
          setSession(opened.session);
          setState('in');
        } else {
          setState('out');
        }
      })
      .catch((err) => {
        console.error('Could not sign in with the browser credential:', err);
        if (!cancelled) {
          setState('out');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  if (state === 'checking') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-500" role="status">
          <LoadingLabel label="Signing in…" />
        </p>
      </div>
    );
  }
  if (state === 'out') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
