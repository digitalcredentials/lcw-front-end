import AppShell from '../components/AppShell';
import { useWalletHost, type WalletPluginPage } from '../plugins';

// The page every plugin route renders: the plugin page's component inside
// the wallet's chrome, given the host object built from the session.
export default function PluginPage({ page }: { page: WalletPluginPage }) {
  const host = useWalletHost();
  return (
    <AppShell>
      <page.Component host={host} />
    </AppShell>
  );
}
