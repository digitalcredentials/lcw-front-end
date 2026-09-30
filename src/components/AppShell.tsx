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

  useEffect(() => {
    isWalletEnabled()
      .then((enabled) => setWalletState(enabled ? 'enabled' : 'disabled'))
      .catch(() => setWalletState('disabled'));
  }, []);

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
            My Space
          </Link>
          <Link
            to="/batches"
            className={itemClass(pathname === '/batches')}
            title="Issue batches of credentials from a CSV"
          >
            Batch Issuer
          </Link>
          <button
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            className={itemClass(false)}
          >
            Settings
          </button>
          {settingsOpen && (
            <div className="ml-3 border-l border-gray-200 pl-3 space-y-1">
              {walletState === 'enabled' ? (
                <>
                  <p className="px-3 text-xs text-green-700">
                    Browser wallet is enabled ✓
                  </p>
                  <button
                    onClick={toggleBrowserWallet}
                    disabled={walletBusy}
                    title="Remove this wallet's registration with your browser (CHAPI)"
                    className="block w-full text-left rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60 transition-colors"
                  >
                    {walletBusy ? 'Working…' : 'Disable browser wallet'}
                  </button>
                </>
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
    </div>
  );
}
