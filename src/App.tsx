import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import FileBrowserPage from './pages/SpaceBrowserPage'
import PluginPage from './pages/PluginPage'
import RequireAuth from './components/RequireAuth'
import { plugins } from './plugins'
import './App.css'

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/files"
          element={
            <RequireAuth>
              <FileBrowserPage />
            </RequireAuth>
          }
        />
        {/* One route per registered plugin (src/plugins/index.ts) */}
        {plugins.map((plugin) => (
          <Route
            key={plugin.path}
            path={plugin.path}
            element={
              <RequireAuth>
                <PluginPage plugin={plugin} />
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
