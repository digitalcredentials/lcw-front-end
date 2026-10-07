import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearToken, getEmail } from '../lib/auth';
import { registerWallet, unregisterWallet, isWalletEnabled } from '../lib/chapi';
import { isWelcomePending, clearWelcomePending, requestWelcomeCredential } from '../lib/welcome';
import LoadingLabel from './LoadingLabel';
import { plugins } from '../plugins';

// The signed-in layout: the product title and navigation run down a left
// sidebar (My Spaces, one link per registered plugin such as Credential
// Issuer, Settings — which holds the browser-wallet registration — and Sign
// Out at the bottom); pages render into the main column.
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

  // The welcome-credential flow, offered on the first open after this
  // browser registered the account: offer (name entry) -> chapi (enable the
  // browser wallet, skipped when already enabled) -> sending -> sent.
  const [welcomeStep, setWelcomeStep] = useState<'offer' | 'chapi' | 'sending' | 'sent' | null>(null);
  const [welcomeName, setWelcomeName] = useState('');
  const [welcomeError, setWelcomeError] = useState('');

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
    // A pending welcome flow replaces the generic enable-wallet prompt: its
    // own CHAPI step covers enabling.
    const welcomePending = isWelcomePending(getEmail());
    if (welcomePending) {
      setWelcomeStep('offer');
    }
    refreshWalletState().then((enabled) => {
      // Only a definitive "not enabled" prompts; a failed query does not
      if (!welcomePending && enabled === false && !sessionStorage.getItem('lcw_wallet_prompt_dismissed')) {
        setEnablePromptOpen(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emails the claim link through the test issuer, then confirms in-wallet.
  async function sendWelcomeCredential() {
    const email = getEmail();
    if (!email) {
      return;
    }
    setWelcomeStep('sending');
    setWelcomeError('');
    try {
      await requestWelcomeCredential(welcomeName.trim(), email);
      clearWelcomePending();
      setWelcomeStep('sent');
    } catch (err) {
      setWelcomeError(err instanceof Error ? err.message : 'The email could not be sent.');
      setWelcomeStep('offer');
    }
  }

  // The offer was accepted: ask about CHAPI unless the browser wallet is
  // already enabled, in which case there is nothing to ask.
  function acceptWelcomeOffer() {
    if (walletState === 'enabled') {
      void sendWelcomeCredential();
    } else {
      setWelcomeError('');
      setWelcomeStep('chapi');
    }
  }

  async function enableWalletForWelcome() {
    setWelcomeError('');
    try {
      await registerWallet();
      setWalletState('enabled');
    } catch (err) {
      setWelcomeError(err instanceof Error ? err.message : 'Could not enable the browser wallet.');
      return;
    }
    await sendWelcomeCredential();
  }

  function declineWelcome() {
    clearWelcomePending();
    setWelcomeStep(null);
  }

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
        {/* The title links home: back to the spaces card view */}
        <Link
          to="/files"
          className="block px-4 py-5 border-b border-gray-200 hover:bg-gray-50 transition-colors"
        >
          <span className="block text-lg font-semibold text-gray-800 leading-tight">
            Digital Credentials Commons
          </span>
          <span className="block text-sm text-gray-500 leading-tight">
            Learner Credential Wallet
          </span>
        </Link>
        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main">
          <Link to="/files" className={itemClass(pathname === '/files')}>
            My Spaces
          </Link>
          {/* One link per registered plugin (src/plugins/index.ts) */}
          {plugins.map((plugin) => (
            <Link
              key={plugin.path}
              to={plugin.path}
              className={itemClass(pathname === plugin.path)}
              title={plugin.description}
            >
              {plugin.title}
            </Link>
          ))}
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
                {walletState === 'unknown' && <LoadingLabel label="Checking…" />}
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

      {/* The welcome-credential flow, on the first open after registration */}
      {welcomeStep && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div
            role="dialog"
            aria-label="Welcome Credential"
            className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6"
          >
            {welcomeStep === 'offer' && (
              <form onSubmit={(e) => { e.preventDefault(); acceptWelcomeOffer(); }}>
                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                  Welcome to your wallet!
                </h2>
                <p className="text-sm text-gray-600 mb-4">
                  To get you started — and to confirm everything is working
                  properly — we would like to issue you a welcome credential
                  from our test issuer. Enter the name you would like on the
                  credential.
                </p>
                <label htmlFor="welcome-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  id="welcome-name"
                  type="text"
                  autoFocus
                  value={welcomeName}
                  onChange={(e) => setWelcomeName(e.target.value)}
                  placeholder="e.g. Robin Lee"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent mb-4"
                />
                {welcomeError && (
                  <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {welcomeError}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={declineWelcome}
                    className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    No thanks
                  </button>
                  <button
                    type="submit"
                    disabled={!welcomeName.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    Issue my credential
                  </button>
                </div>
              </form>
            )}

            {welcomeStep === 'chapi' && (
              <>
                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                  Enable your browser wallet?
                </h2>
                <p className="text-sm text-gray-600 mb-3">
                  Claiming your welcome credential happens through your
                  browser, so we would like to register this wallet with it
                  (CHAPI). That also lets you receive credentials from other
                  issuers&#39; websites, not just ours.
                </p>
                <p className="text-sm text-gray-600 mb-4">
                  You can enable or disable this at any time under Settings.
                </p>
                {welcomeError && (
                  <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {welcomeError}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => void sendWelcomeCredential()}
                    className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={() => void enableWalletForWelcome()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    Enable browser wallet
                  </button>
                </div>
              </>
            )}

            {welcomeStep === 'sending' && (
              <p className="text-sm text-gray-600 py-4 text-center">
                Sending your welcome credential email…
              </p>
            )}

            {welcomeStep === 'sent' && (
              <>
                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                  Check your email
                </h2>
                <p className="text-sm text-gray-600 mb-5">
                  We have emailed a claim link for your welcome credential to{' '}
                  <span className="font-medium text-gray-800">{getEmail()}</span>.
                  Open the link and click <span className="font-medium">Add to Wallet</span> to
                  claim it into this wallet.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => setWelcomeStep(null)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
