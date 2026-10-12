import '@digitalcredentials/verifier-plugin'; // registers <verifier-credential>
import type { Registry } from '@digitalcredentials/verifier-plugin';
import type { WalletHost } from './types';

// The registries the verifier looks an issuer up in: the wallet's own trust
// list, passed to the element as a property. Sandbox issuers that are not
// listed (the batch issuer's per-batch DIDs, say) still verify; the card then
// says it could not confirm who issued the credential.
const REGISTRIES: Registry[] = [
  {
    name: 'DCC Sandbox Registry',
    type: 'dcc-legacy',
    url: 'https://digitalcredentials.github.io/sandbox-registry/registry.json',
  },
];

// The credentialDetail slot: the verifier-plugin card for the opened
// credential. Setting `credential` runs the check; undefined clears the card.
export default function VerifierDetail({
  credential,
}: {
  credential: Record<string, unknown> | null;
  host: WalletHost;
}) {
  return <verifier-credential credential={credential ?? undefined} registries={REGISTRIES} />;
}
