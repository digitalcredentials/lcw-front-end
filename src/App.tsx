import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ForgotPage from './pages/ForgotPage'
import WalletPage from './pages/WalletPage'
import PluginPage from './pages/PluginPage'
import CredentialsPage from './pages/CredentialsPage'
import WalletsPage from './pages/WalletsPage'
import RequireAuth from './components/RequireAuth'
import { pluginPages } from './plugins'
import './App.css'

function App() {
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
