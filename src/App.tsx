import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ForgotPage from './pages/ForgotPage'
import WalletPage from './pages/WalletPage'
import PluginPage from './pages/PluginPage'
import CredentialsPage from './pages/CredentialsPage'
import WalletsPage from './pages/WalletsPage'
import EmailUpdatesPage from './pages/EmailUpdatesPage'
import RequireAuth from './components/RequireAuth'
import LoadingLabel from './components/LoadingLabel'
import { isAuthenticated } from './lib/auth'
import { browserRemembered } from './lib/identity'
import { isPlainAddress, welcomePageUrl } from './lib/welcomePage'
import { pluginPages } from './plugins'
import './App.css'

// The welcome page this visit goes to instead of the wallet: a signed-out
// visitor at the plain address, on a deployment that has one. Read before
// the router turns the plain address into #/files.
function welcomeTarget(): string | undefined {
  const welcome = welcomePageUrl()
  return welcome && isPlainAddress(window.location) && !isAuthenticated() ? welcome : undefined
}

function App() {
  const [welcome] = useState(welcomeTarget)
  const [open, setOpen] = useState(!welcome)

  // A browser a passkey remembers is signed in, so it opens the wallet (and
  // its passkey prompt) as before; a browser that cannot tell does too
  useEffect(() => {
    if (!welcome) {
      return
    }
    let cancelled = false
    browserRemembered()
      .catch(() => true)
      .then((remembered) => {
        if (cancelled) {
          return
        }
        if (remembered) {
          setOpen(true)
        } else {
          window.location.replace(welcome)
        }
      })
    return () => {
      cancelled = true
    }
  }, [welcome])

  if (!open) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-500" role="status">
          <LoadingLabel label="Checking…" />
        </p>
      </div>
    )
  }
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route
          path="/files"
          element={
            <RequireAuth>
              <WalletPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/credentials"
          element={
            <RequireAuth>
              <CredentialsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/wallets"
          element={
            <RequireAuth>
              <WalletsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings/email"
          element={
            <RequireAuth>
              <EmailUpdatesPage />
            </RequireAuth>
          }
        />
        {/* One route per plugin page (src/plugins/index.ts) */}
        {pluginPages.map(({ plugin, page }) => (
          <Route
            key={plugin.id}
            path={page.path}
            element={
              <RequireAuth>
                <PluginPage page={page} />
              </RequireAuth>
            }
          />
        ))}
        <Route path="*" element={<Navigate to="/files" replace />} />
      </Routes>
    </HashRouter>
  )
}

export default App
