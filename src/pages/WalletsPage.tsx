import { useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import {
  getSession,
  listConnectedWallets,
  approveConnectCode,
  disconnectWallet,
  renameConnectedWallet,
  inspectConnectCode,
  refusalMessage,
  type ConnectedWallet,
} from '../lib/identity';

// Settings → Connected wallets: the wallets enrolled on the account (every
// client the account document lists, named from the account's connections
// directory), with renaming, disconnecting, and approving the connect code
// another wallet shows.

function connectedOn(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// A did:key, shortened for display: its first and last characters
function shortDid(did: string): string {
  return did.length > 32 ? `${did.slice(0, 20)}…${did.slice(-8)}` : did;
}

function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<ConnectedWallet[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Renaming: the row being edited and its draft
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Connecting another wallet: the pasted code, what it names, the name to give it
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeClientDid, setCodeClientDid] = useState('');
  const [newName, setNewName] = useState('');
  const session = getSession();
  const transient = session?.kind === 'transient';

  async function load() {
    const current = getSession();
    if (!current) {
      return;
    }
    setLoadError('');
    try {
      const listed = await listConnectedWallets({ ...current });
      setWallets(listed);
      setNewName((name) => name || `Wallet ${listed.length + 1}`);
    } catch (err) {
      setLoadError(describe(err, 'The connected wallets could not be listed.'));
      setWallets([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function onCodeChange(value: string) {
    setCode(value);
    setCodeError('');
    setCodeClientDid('');
    if (!value.trim()) {
      return;
    }
    try {
      setCodeClientDid(inspectConnectCode(value).clientDid);
    } catch (err) {
      setCodeError(describe(err, 'Not a wallet connect code.'));
    }
  }

  async function handleApprove() {
    const current = getSession();
    if (!current || !codeClientDid) {
      return;
    }
    setBusy('approve');
    setError('');
    setNotice('');
    try {
      const suggested = `Wallet ${(wallets?.length ?? 0) + 1}`;
      const typed = newName.trim();
      await approveConnectCode({ session: current, code, name: suggested, ...(typed && typed !== suggested && { label: typed }) });
      setNotice(`${typed || suggested} is connected. It can finish connecting now.`);
      setCode('');
      setCodeClientDid('');
      setNewName('');
      await load();
    } catch (err) {
      setError(describe(err, 'The wallet could not be connected. Please try again.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRename(wallet: ConnectedWallet) {
    const current = getSession();
    if (!current) {
      return;
    }
    setBusy(wallet.signingKeyMultibase);
    setError('');
    setNotice('');
    try {
      await renameConnectedWallet({ session: current, signingKeyMultibase: wallet.signingKeyMultibase, label: draft.trim() });
      setRenaming(null);
      await load();
    } catch (err) {
      setError(describe(err, 'The wallet could not be renamed.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(wallet: ConnectedWallet) {
    const current = getSession();
    if (!current) {
      return;
    }
    if (
      !window.confirm(
        `Disconnect "${wallet.displayName}"?\n\nIt will no longer open this account. Anything it already fetched stays readable to it; nothing written from now on is.`
      )
    ) {
      return;
    }
    setBusy(wallet.signingKeyMultibase);
    setError('');
    setNotice('');
    try {
      const outcome = await disconnectWallet({ session: current, wallet });
      setNotice(
        outcome.completion === 'complete'
          ? `${wallet.displayName} is disconnected.`
          : `${wallet.displayName} is disconnected. One of the account's collections could not be re-keyed yet; the next disconnection or sign-in method removal finishes it.`
      );
      await load();
    } catch (err) {
      setError(describe(err, 'The wallet could not be disconnected. Please try again.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold text-gray-800 mb-1">Connected wallets</h1>
      <p className="text-sm text-gray-500 mb-6">
        The wallets that open this account as enrolled clients: browsers this wallet remembers with a passkey, and
        other wallets connected by code. Disconnecting one re-keys the account; what it already fetched stays with it.
        {transient && ' This browser is signed in with a password for this tab only, so it is not one of them.'}
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

      {wallets === null ? (
        <p className="text-sm text-gray-500">
          <LoadingLabel label="Loading…" />
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 bg-white rounded-2xl shadow-sm border border-gray-200" aria-label="Connected wallets">
          {wallets.map((wallet) => (
            <li
              key={wallet.signingKeyMultibase}
              data-wallet-key={wallet.signingKeyMultibase}
              data-wallet-current={wallet.isCurrent ? 'true' : 'false'}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                {renaming === wallet.signingKeyMultibase ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleRename(wallet);
                    }}
                  >
                    <label htmlFor="wallet-name" className="sr-only">
                      Wallet name
                    </label>
                    <input
                      id="wallet-name"
                      autoFocus
                      value={draft}
                      maxLength={64}
                      onChange={(e) => setDraft(e.target.value)}
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <button type="submit" disabled={busy !== null} className="text-sm font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-60">
                      Save
                    </button>
                    <button type="button" onClick={() => setRenaming(null)} className="text-sm text-gray-500 hover:text-gray-700">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p className="text-sm font-medium text-gray-800">
                    {wallet.displayName}
                    {wallet.isCurrent && (
                      <span className="ml-2 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 align-middle">
                        This browser
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRenaming(wallet.signingKeyMultibase);
                        setDraft(wallet.label ?? wallet.name ?? '');
                      }}
                      className="ml-2 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      Rename
                    </button>
                  </p>
                )}
                <p className="text-xs text-gray-500 mt-0.5 break-all" title={wallet.did}>
                  Key fingerprint: {shortDid(wallet.did)}
                  {wallet.addedAt && <>. Connected {connectedOn(wallet.addedAt)}.</>}
                </p>
              </div>
              {wallet.canDisconnect ? (
                <button
                  type="button"
                  onClick={() => void handleDisconnect(wallet)}
                  disabled={busy !== null}
                  className="shrink-0 border border-red-200 hover:bg-red-50 disabled:opacity-60 text-red-600 font-medium text-sm rounded-lg px-3 py-1.5 transition-colors"
                >
                  {busy === wallet.signingKeyMultibase ? 'Working…' : 'Disconnect'}
                </button>
              ) : (
                <span className="shrink-0 text-xs text-gray-400" title={refusalMessage(wallet.refusal)}>
                  {wallet.isCurrent ? 'In use' : 'Listed'}
                </span>
              )}
            </li>
          ))}
          {wallets.length === 0 && !loadError && (
            <li className="px-5 py-4 text-sm text-gray-500">No wallet is connected to this account as an enrolled client.</li>
          )}
        </ul>
      )}

      <section className="mt-8 bg-white rounded-2xl shadow-sm border border-gray-200 px-5 py-4" aria-labelledby="connect-heading">
        <h2 id="connect-heading" className="text-base font-semibold text-gray-800 mb-1">
          Connect another wallet
        </h2>
        <p className="text-sm text-gray-500 mb-3">
          On the other wallet, choose to connect it to an existing account and copy the connect code it shows. Paste the
          code here, compare the key fingerprint with the one shown there, and approve. The other wallet then finishes
          connecting on its side.
        </p>
        <label htmlFor="connect-code" className="block text-sm font-medium text-gray-700 mb-1">
          Connect code
        </label>
        <textarea
          id="connect-code"
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="freewallet-connect:…"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        {codeError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {codeError}
          </p>
        )}
        {codeClientDid && (
          <p className="mt-2 text-xs text-gray-600 break-all" data-testid="connect-code-fingerprint">
            New wallet key: {codeClientDid}. Compare it with the fingerprint the other wallet shows before approving.
          </p>
        )}
        <label htmlFor="new-wallet-name" className="block text-sm font-medium text-gray-700 mt-3 mb-1">
          Wallet name
        </label>
        <input
          id="new-wallet-name"
          value={newName}
          maxLength={64}
          onChange={(e) => setNewName(e.target.value)}
          className="w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={busy !== null || !codeClientDid}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
          >
            {busy === 'approve' ? 'Connecting…' : 'Approve'}
          </button>
        </div>
      </section>
    </AppShell>
  );
}
