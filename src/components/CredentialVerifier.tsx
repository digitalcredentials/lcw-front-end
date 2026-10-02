import { useEffect, useState } from 'react';
import '@digitalcredentials/verifier-plugin';
import type { Registry } from '@digitalcredentials/verifier-plugin';
import { knownDIDRegistries } from '../lib/verify';

// The verifier-plugin card: checks a credential in the browser and shows the
// result. Issuers are looked up in the DCC known-registries list, the same list
// the pre-share check uses. The credential is held back until
// that list has loaded (or failed to), so it is checked once, not twice. If the
// list can't be loaded, the card falls back to its own default registry.
export default function CredentialVerifier({ credential }: { credential?: Record<string, unknown> }) {
  const [registries, setRegistries] = useState<{ loaded: boolean; list?: Registry[] }>({ loaded: false });

  useEffect(() => {
    let current = true;
    knownDIDRegistries().then(
      (list) => current && setRegistries({ loaded: true, list: list as Registry[] }),
      (err) => {
        console.error('Could not load the known registries:', err);
        if (current) setRegistries({ loaded: true });
      }
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <verifier-credential
      registries={registries.list}
      credential={registries.loaded ? credential : undefined}
    />
  );
}
