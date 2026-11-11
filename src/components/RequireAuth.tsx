import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { isAuthenticated } from '../lib/auth';
import { browserRemembered, loginWithPasskey, setSession, PasskeyCancelledError } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import Brand from './Brand';
import LoadingLabel from './LoadingLabel';

interface Props {
  children: ReactNode;
}

// Guards the signed-in pages. With no session in this tab, a browser that
// a passkey remembers offers to continue with it (the passkey's tap opens
// the client this browser keeps); any other browser goes to the sign-in
// form.
export default function RequireAuth({ children }: Props) {
  const navigate = useNavigate();
  const [state, setState] = useState<'checking' | 'in' | 'passkey' | 'out'>(() => (isAuthenticated() ? 'in' : 'checking'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (state !== 'checking') {
      return;
    }
    let cancelled = false;
    browserRemembered()
      .then((remembered) => {
        if (!cancelled) {
          setState(remembered ? 'passkey' : 'out');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState('out');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  async function continueWithPasskey() {
    setBusy(true);
    setError('');
    try {
      setSession(await loginWithPasskey({ config: identityConfig() }));
      setState('in');
    } catch (err) {
      setError(err instanceof PasskeyCancelledError ? 'The passkey step was cancelled.' : 'The passkey could not open the account. Sign in another way.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-500" role="status">
          <LoadingLabel label="Checking…" />
        </p>
      </div>
    );
  }
  if (state === 'passkey') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <header className="text-center mb-6">
            <Brand centered />
          </header>
          <div className="w-full bg-white rounded-2xl shadow-md p-8" role="status">
            <h2 className="text-2xl font-semibold text-gray-800 mb-1">Welcome back</h2>
            <p className="text-sm text-gray-500 mb-6">This browser is signed in with a passkey. Confirm it to continue.</p>
            {error && (
              <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={continueWithPasskey}
              disabled={busy}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              {busy ? 'Opening…' : 'Continue with passkey'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              disabled={busy}
              className="mt-3 w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5"
            >
              Sign in another way
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (state === 'out') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
