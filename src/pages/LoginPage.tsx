import { useEffect, useRef, useState, type FormEvent } from 'react';
import Brand from '../components/Brand';
import PasswordInput from '../components/PasswordInput';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  openWithPassphrase,
  openWithPasskey,
  ensureRecoveryCredential,
  addPasskey,
  setSession,
  passkeySupported,
  PasskeyCancelledError,
  PasskeyUnsupportedError,
  type CredentialKeys,
  type Session,
} from '../lib/identity';
import { identityConfig } from '../lib/identity/config';

const RP_NAME = 'Learner Credential Wallet';
const DISMISSED_KEY = (email: string) => `lcw_passkey_offer_dismissed:${email.trim().toLowerCase()}`;

function offerDismissed(email: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY(email)) === 'true';
  } catch {
    return true;
  }
}

function dismissOffer(email: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY(email), 'true');
  } catch {
    // Nothing to remember with; the offer shows again next time.
  }
}

// After a sign-in, an account with no stored recovery code gets one. Best
// effort: the user is signed in either way, and the next sign-in tries again.
async function ensureRecovery(session: Session, acting: CredentialKeys): Promise<void> {
  try {
    await ensureRecoveryCredential({ session, acting, config: identityConfig() });
  } catch (err) {
    console.error('Could not set up account recovery:', err);
  }
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof PasskeyCancelledError) {
    return 'The passkey step was cancelled.';
  }
  if (err instanceof PasskeyUnsupportedError) {
    return err.message;
  }
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 401) {
    return 'Invalid email or password.';
  }
  return fallback;
}

export default function LoginPage() {
  const navigate = useNavigate();
  // Sent here because the session was ended for the person (see handleError):
  // say why, so the bounce to sign-in doesn't look like a fault. Read once and
  // dropped from the history entry, so Back or a reload doesn't repeat it.
  const location = useLocation();
  const [signedOut] = useState((location.state as { signedOut?: boolean } | null)?.signedOut === true);
  useEffect(() => {
    if (signedOut) {
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // After a passphrase sign-in on a browser with passkey support, the page
  // offers to add a passkey before continuing. The passphrase credential's
  // keys (its update key among them) are held only for that step.
  const [offering, setOffering] = useState<Session | null>(null);
  const actingRef = useRef<CredentialKeys | null>(null);

  function enter(session: Session) {
    setSession(session);
    navigate('/files');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // The passphrase derives the unlock identity, whose space holds the
      // account pointer and the credential's keys; the signing key then
      // proves the account to the back end (src/lib/identity).
      const { session, keys } = await openWithPassphrase({ email, passphrase: password, config: identityConfig() });
      await ensureRecovery(session, keys.credential);
      if (passkeySupported() && !offerDismissed(session.email)) {
        actingRef.current = keys.credential;
        setOffering(session);
      } else {
        enter(session);
      }
    } catch (err) {
      setError(describe(err, 'Unable to connect. Please try again.'));
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskeySignIn() {
    setError('');
    setLoading(true);
    try {
      const { session, keys } = await openWithPasskey({ config: identityConfig() });
      await ensureRecovery(session, keys.credential);
      enter(session);
    } catch (err) {
      setError(describe(err, 'Unable to sign in with a passkey. Please try again.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleAddPasskey() {
    if (!offering || !actingRef.current) {
      return;
    }
    setError('');
    setLoading(true);
    try {
      await addPasskey({ session: offering, acting: actingRef.current, config: identityConfig(), rpName: RP_NAME });
      dismissOffer(offering.email);
      actingRef.current = null;
      enter(offering);
    } catch (err) {
      setError(describe(err, 'The passkey could not be added. You can try again next time you sign in.'));
    } finally {
      setLoading(false);
    }
  }

  function handleNotNow() {
    if (!offering) {
      return;
    }
    dismissOffer(offering.email);
    actingRef.current = null;
    enter(offering);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="text-center mb-6">
          <Brand centered />
          <p className="mt-3 text-xs font-semibold tracking-wide text-amber-700">
            THIS IS A SANDBOX FOR TESTING AND WILL BE RESET FREQUENTLY
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-amber-700">
            DO NOT STORE ANYTHING YOU&#39;D LIKE TO KEEP
          </p>
        </header>
        <div className="w-full bg-white rounded-2xl shadow-md p-8">
        {offering ? (
          <div role="status">
            <h2 className="text-2xl font-semibold text-gray-800 mb-1">Add a passkey?</h2>
            <p className="text-sm text-gray-500 mb-6">
              A passkey lets you sign in to this account with your device&#39;s screen lock instead of
              your password. You can add one now or the next time you sign in.
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={handleAddPasskey}
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              {loading ? 'Adding the passkey…' : 'Add a passkey'}
            </button>
            <button
              type="button"
              onClick={handleNotNow}
              disabled={loading}
              className="mt-3 w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5"
            >
              Not now
            </button>
          </div>
        ) : (
        <>
        <h2 className="text-2xl font-semibold text-gray-800 mb-1">Sign in</h2>
        <p className="text-sm text-gray-500 mb-6">Enter your credentials to continue</p>
        {signedOut && (
          <p role="status" className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-4">
            For your security, you've been signed out. Sign in again to continue.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <PasswordInput id="password" autoComplete="current-password" value={password} onChange={setPassword} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {passkeySupported() && (
          <button
            type="button"
            onClick={handlePasskeySignIn}
            disabled={loading}
            className="mt-3 w-full border border-gray-300 hover:bg-gray-50 disabled:bg-gray-100 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5"
          >
            Sign in with a passkey
          </button>
        )}
        </>
        )}
        {!offering && (
          <p className="mt-4 text-sm text-center">
            <Link to="/forgot" className="text-indigo-600 hover:text-indigo-700 font-medium">
              Forgot your password?
            </Link>
          </p>
        )}
        <p className="mt-5 text-sm text-gray-500 text-center">
          Need an account?{' '}
          <Link to="/register" className="text-indigo-600 hover:text-indigo-700 font-medium">
            Create one
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
