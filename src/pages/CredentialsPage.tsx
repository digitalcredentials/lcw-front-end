import { useEffect, useState, type FormEvent } from 'react';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import PasswordInput from '../components/PasswordInput';
import {
  getSession,
  listCredentials,
  removeCredential,
  confirmWithPassphrase,
  confirmWithPasskey,
  passkeySupported,
  PasskeyCancelledError,
  PasskeyUnsupportedError,
  type AccountCredential,
  type CredentialKeys,
} from '../lib/identity';
import { identityConfig } from '../lib/identity/config';

// Settings → Sign-in credentials: the account's credentials as the account
// document lists them (joined with the catalogue for their kind), and
// removal of one. Removing rewrites the account document, which a session
// cannot do on its own: the user confirms with a password or a passkey of
// the account, whose update key signs the one entry.

const KIND_LABEL: Record<AccountCredential['kind'], string> = {
  passphrase: 'Password',
  passkey: 'Passkey',
  recovery: 'Recovery code',
  unknown: 'Credential',
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
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 401) {
    return 'That password is not one of this account\'s.';
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function CredentialsPage() {
  const [credentials, setCredentials] = useState<AccountCredential[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  // The credential a removal dialog is open for
  const [removing, setRemoving] = useState<AccountCredential | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const session = getSession();
    if (!session) {
      return;
    }
    setLoadError('');
    try {
      setCredentials(await listCredentials({ session }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The credentials could not be listed.');
      setCredentials([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openRemoval(credential: AccountCredential) {
    setRemoving(credential);
    setPassword('');
    setError('');
    setNotice('');
  }

  function closeRemoval() {
    if (busy) {
      return;
    }
    setRemoving(null);
    setPassword('');
    setError('');
  }

  // Removes `removing` with the keys a confirmation step produced.
  async function removeWith(confirm: () => Promise<CredentialKeys>) {
    const session = getSession();
    if (!session || !removing) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const acting = await confirm();
      const { retired } = await removeCredential({ session, acting, credential: removing, config: identityConfig() });
      setNotice(
        retired
          ? `${KIND_LABEL[removing.kind]} removed.`
          : `${KIND_LABEL[removing.kind]} removed from the account. Its sign-in records could not be retired from the server; they no longer open the account.`
      );
      setRemoving(null);
      setPassword('');
      await load();
    } catch (err) {
      setError(describe(err, 'The credential could not be removed. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  function handlePasswordConfirm(e: FormEvent) {
    e.preventDefault();
    const session = getSession();
    if (!session) {
      return;
    }
    void removeWith(() => confirmWithPassphrase({ session, passphrase: password, config: identityConfig() }));
  }

  function handlePasskeyConfirm() {
    const session = getSession();
    if (!session) {
      return;
    }
    void removeWith(() => confirmWithPasskey({ session, config: identityConfig() }));
  }

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold text-gray-800 mb-1">Sign-in credentials</h1>
      <p className="text-sm text-gray-500 mb-6">
        The ways this account can be opened. Each one has keys of its own in your account document;
        removing one takes those keys out, so whoever holds it can no longer sign in.
      </p>

      {notice && (
        <p role="status" className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {notice}
        </p>
      )}
      {loadError && (
        <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {loadError}
        </p>
      )}

      {credentials === null ? (
        <p className="text-sm text-gray-500">
          <LoadingLabel label="Loading…" />
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 bg-white rounded-2xl shadow-sm border border-gray-200" aria-label="Sign-in credentials">
          {credentials.map((credential) => (
            <li
              key={credential.signingMultibase}
              data-credential-kind={credential.kind}
              data-credential-current={credential.current ? 'true' : 'false'}
              className="flex items-center gap-4 px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800">
                  {KIND_LABEL[credential.kind]}
                  {credential.label && <span className="font-normal text-gray-500"> · {credential.label}</span>}
                  {credential.current && (
                    <span className="ml-2 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 align-middle">
                      This session
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {credential.addedAt && <>Added {addedOn(credential.addedAt)}. </>}
                  {credential.kind === 'recovery' && 'Emailed on request from "Forgot your password?" and replaced after each use.'}
                  {credential.kind === 'unknown' && 'Added before this wallet kept a record of its credentials; it will be recognised the next time it signs in.'}
                </p>
              </div>
              {credential.removable ? (
                <button
                  type="button"
                  onClick={() => openRemoval(credential)}
                  className="shrink-0 border border-gray-300 hover:bg-red-50 hover:border-red-300 hover:text-red-700 text-gray-700 font-medium text-sm rounded-lg px-3 py-1.5 transition-colors"
                >
                  Remove
                </button>
              ) : (
                <span
                  className="shrink-0 text-xs text-gray-400"
                  title={
                    credential.current
                      ? 'You are signed in with this credential; sign in with another one to remove it.'
                      : credential.kind === 'recovery'
                        ? 'The recovery code is managed for you.'
                        : 'This credential cannot be removed by the wallet.'
                  }
                >
                  {credential.current ? 'In use' : credential.kind === 'recovery' ? 'Managed' : 'Fixed'}
                </span>
              )}
            </li>
          ))}
          {credentials.length === 0 && !loadError && (
            <li className="px-5 py-4 text-sm text-gray-500">No credentials are listed for this account.</li>
          )}
        </ul>
      )}

      {removing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={closeRemoval}>
          <div
            role="dialog"
            aria-label="Remove credential"
            className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              Remove this {KIND_LABEL[removing.kind].toLowerCase()}?
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Its keys are taken out of your account, and it can no longer sign in.
              {removing.kind === 'passkey' && ' The passkey itself stays on the device it was created on; delete it there too.'}{' '}
              To continue, confirm with your password, or with a passkey of this account.
            </p>
            <form onSubmit={handlePasswordConfirm} className="space-y-3" noValidate>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <PasswordInput id="confirm-password" autoComplete="current-password" value={password} onChange={setPassword} />
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeRemoval}
                  disabled={busy}
                  className="border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  Cancel
                </button>
                {passkeySupported() && (
                  <button
                    type="button"
                    onClick={handlePasskeyConfirm}
                    disabled={busy}
                    className="border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    Confirm with a passkey
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy || !password}
                  className="bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {busy ? 'Removing…' : 'Remove with password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
