import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearToken } from '../lib/auth';
import { registerWallet, unregisterWallet, isWalletEnabled } from '../lib/chapi';

// The signed-in layout: the product title and navigation run down a left
// sidebar (My Space, Batch Issuer, Settings — which holds the browser-wallet
// registration — and Sign Out at the bottom); pages render into the main
// column.
export default function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 'unknown' until the CHAPI permission is queried; then reflects reality
  const [walletState, setWalletState] = useState<'unknown' | 'enabled' | 'disabled'>('unknown');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState('');

  // Shown when the wallet opens while the browser wallet is not enabled; at
  // most once per tab session
  const [enablePromptOpen, setEnablePromptOpen] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState('');

  // Queried at mount AND every time Settings opens: the mount-time query can
  // race the CHAPI mediator's setup and mis-report, so opening the menu
  // re-checks the real permission state.
  function refreshWalletState() {
    return isWalletEnabled()
      .then((enabled) => {
        setWalletState(enabled ? 'enabled' : 'disabled');
        return enabled;
      })
      .catch(() => {
        setWalletState('unknown');
        return null;
      });
  }

  useEffect(() => {
    refreshWalletState().then((enabled) => {
      // Only a definitive "not enabled" prompts; a failed query does not
      if (enabled === false && !sessionStorage.getItem('lcw_wallet_prompt_dismissed')) {
        setEnablePromptOpen(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissEnablePrompt() {
    sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true');
    setEnablePromptOpen(false);
  }

  async function enableFromPrompt() {
    setPromptBusy(true);
    setPromptError('');
    try {
      await registerWallet();
      setWalletState('enabled');
      dismissEnablePrompt();
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : 'Could not enable the browser wallet.');
    } finally {
      setPromptBusy(false);
    }
  }

  function toggleSettings() {
    setSettingsOpen((open) => {
      if (!open) {
        refreshWalletState();
      }
      return !open;
    });
  }

  async function toggleBrowserWallet() {
    setWalletBusy(true);
    setWalletError('');
    try {
      if (walletState === 'enabled') {
        await unregisterWallet();
        setWalletState('disabled');
      } else {
        await registerWallet();
        setWalletState('enabled');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'UNAUTHORIZED') {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      setWalletError(err instanceof Error ? err.message : 'Could not update the browser wallet registration.');
    } finally {
      setWalletBusy(false);
    }
  }

  function signOut() {
    clearToken();
    navigate('/login', { replace: true });
  }

  const itemClass = (active: boolean) =>
    `block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-indigo-50 text-indigo-700'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800'
    }`;

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-200">
          <span className="block text-lg font-semibold text-gray-800 leading-tight">
            Digital Credentials Commons
          </span>
          <span className="block text-sm text-gray-500 leading-tight">
            Learner Credential Wallet
          </span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main">
          <Link to="/files" className={itemClass(pathname === '/files')}>
            My Spaces
          </Link>
          <Link
            to="/batches"
            className={itemClass(pathname === '/batches')}
            title="Issue batches of credentials from a CSV"
          >
            Batch Issuer
          </Link>
          <button
            onClick={toggleSettings}
            aria-expanded={settingsOpen}
            className={itemClass(false)}
          >
            Settings
          </button>
          {settingsOpen && (
            <div className="ml-3 border-l border-gray-200 pl-3 space-y-1">
              <p className="px-3 text-xs uppercase tracking-wide">
                <span className="text-gray-400">Browser wallet: </span>
                {walletState === 'enabled' && (
                  <span className="font-semibold text-green-700">Enabled</span>
                )}
                {walletState === 'disabled' && (
                  <span className="font-semibold text-red-600">Disabled</span>
                )}
                {walletState === 'unknown' && (
                  <span className="font-semibold text-gray-400">Checking…</span>
                )}
              </p>
              {walletState === 'enabled' ? (
                <button
                  onClick={toggleBrowserWallet}
                  disabled={walletBusy}
                  title="Remove this wallet's registration with your browser (CHAPI)"
                  className="block w-full text-left rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60 transition-colors"
                >
                  {walletBusy ? 'Working…' : 'Disable browser wallet'}
                </button>
              ) : (
                <button
                  onClick={toggleBrowserWallet}
                  disabled={walletBusy || walletState === 'unknown'}
                  title="Register this wallet with your browser so issuer sites can offer it (CHAPI)"
                  className="block w-full text-left rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:text-gray-400 transition-colors"
                >
                  {walletBusy ? 'Working…' : 'Enable browser wallet'}
                </button>
              )}
              {walletError && (
                <p role="alert" className="px-3 text-xs text-red-600">
                  {walletError}
                </p>
              )}
            </div>
          )}
        </nav>
        <div className="px-3 py-4 border-t border-gray-200">
          <button onClick={signOut} className={itemClass(false)}>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="max-w-4xl mx-auto px-4 py-8">{children}</div>
      </main>

      {/* Shown once per tab session when the browser wallet is not enabled */}
      {enablePromptOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={dismissEnablePrompt}
        >
          <div
            role="dialog"
            aria-label="Enable Browser Wallet"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              Enable your browser wallet?
            </h2>
            <p className="text-sm text-gray-600 mb-3">
              Your browser wallet is not enabled. Enabling it registers this
              wallet with your browser, so that when an issuer offers you a
              credential or a verifier asks for one, your browser can hand the
              request to this wallet.
            </p>
            <p className="text-sm text-gray-600 mb-5">
              Without it, claiming and sharing credentials through other
              websites will not work. You can enable or disable it at any time
              under Settings.
            </p>
            {promptError && (
              <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {promptError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={dismissEnablePrompt}
                disabled={promptBusy}
                className="border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Not now
              </button>
              <button
                onClick={enableFromPrompt}
                disabled={promptBusy}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {promptBusy ? 'Working…' : 'Enable browser wallet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
