import AppShell from '../components/AppShell';
import { useWalletHost, type WalletPlugin } from '../plugins';

// The page every plugin route renders: the plugin's component inside the
// wallet's chrome, given the host object built from the session.
export default function PluginPage({ plugin }: { plugin: WalletPlugin }) {
  const host = useWalletHost();
  return (
    <AppShell>
      <plugin.Component host={host} />
    </AppShell>
  );
}
