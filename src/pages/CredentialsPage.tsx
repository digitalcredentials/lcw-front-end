import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import {
  getSession,
  setSession,
  listSignInMethods,
  addPasskey,
  forgetThisBrowser,
  browserRemembered,
  passkeySupported,
  PasskeyCancelledError,
  PasskeyUnsupportedError,
  type SignInMethod,
} from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import { RP_NAME } from './LoginPage';

// Settings → Sign-in credentials: the account's sign-in methods as its
// unlock-methods registry lists them (the same list FreeWallet shows for
// the account), adding a passkey, and forgetting this browser.

const KIND_LABEL: Record<SignInMethod['kind'], string> = {
  passphrase: 'Password',
  passkey: 'Passkey',
  'recovery-code': 'Recovery code',
  'backup-credential': 'Backup file',
};

function addedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof PasskeyCancelledError) {
    return 'The passkey step was cancelled.';
  }
  if (err instanceof PasskeyUnsupportedError) {
    return err.message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function CredentialsPage() {
  const [methods, setMethods] = useState<SignInMethod[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const session = getSession();

  async function load() {
    const current = getSession();
    if (!current) {
      return;
    }
    setLoadError('');
    try {
      setMethods(await listSignInMethods({ session: current }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The sign-in methods could not be listed.');
      setMethods([]);
    }
    setRemembered(await browserRemembered().catch(() => false));
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAddPasskey() {
    const current = getSession();
    if (!current) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await addPasskey({ session: current, config: identityConfig(), rpName: RP_NAME });
      setSession(next);
      setNotice('Passkey added. This browser now stays signed in with it.');
      await load();
    } catch (err) {
      setError(describe(err, 'The passkey could not be added. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleForgetBrowser() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await forgetThisBrowser();
      setNotice('This browser no longer keeps you signed in. Your passkey still opens the account.');
      setRemembered(false);
    } catch (err) {
      setError(describe(err, 'This browser could not be forgotten.'));
    } finally {
      setBusy(false);
    }
  }

  const transient = session?.kind === 'transient';

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold text-gray-800 mb-1">Sign-in credentials</h1>
      <p className="text-sm text-gray-500 mb-6">
        The ways this account can be opened, as your account&#39;s own list records them. A password
        signs in for one tab; a passkey keeps a browser signed in and lets it manage your spaces.
      </p>

      {notice && (
        <p role="status" className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {notice}
        </p>
      )}
      {(loadError || error) && (
        <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {loadError || error}
        </p>
      )}

      {methods === null ? (
        <p className="text-sm text-gray-500">
          <LoadingLabel label="Loading…" />
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 bg-white rounded-2xl shadow-sm border border-gray-200" aria-label="Sign-in credentials">
          {methods.map((method) => (
            <li
              key={method.unlockSpaceId}
              data-credential-kind={method.kind}
              data-credential-current={method.current ? 'true' : 'false'}
              className="flex items-center gap-4 px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800">
                  {KIND_LABEL[method.kind]}
                  {method.kind !== 'passphrase' && method.label && method.label !== KIND_LABEL[method.kind] && (
                    <span className="font-normal text-gray-500"> · {method.label}</span>
                  )}
                  {method.current && (
                    <span className="ml-2 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 align-middle">
                      This session
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {method.createdAt && <>Added {addedOn(method.createdAt)}. </>}
                  {method.kind === 'recovery-code' && 'Emailed on request from "Forgot your password?" and replaced after each use.'}
                  {method.kind === 'passkey' && 'Opens the account with the device it was created on, and keeps that browser signed in.'}
                </p>
              </div>
              <span className="shrink-0 text-xs text-gray-400" title={method.current ? 'You are signed in with this credential.' : 'Removing a credential is not available yet in this wallet.'}>
                {method.current ? 'In use' : method.kind === 'recovery-code' ? 'Managed' : 'Listed'}
              </span>
            </li>
          ))}
          {methods.length === 0 && !loadError && (
            <li className="px-5 py-4 text-sm text-gray-500">No sign-in methods are listed for this account.</li>
          )}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        {transient && passkeySupported() && (
          <button
            type="button"
            onClick={handleAddPasskey}
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
          >
            {busy ? 'Working…' : 'Add a passkey'}
          </button>
        )}
        {remembered && (
          <button
            type="button"
            onClick={handleForgetBrowser}
            disabled={busy}
            className="border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
          >
            Forget this browser
          </button>
        )}
      </div>
    </AppShell>
  );
}
