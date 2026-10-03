import { useEffect, useState } from 'react';
import '@digitalcredentials/verifier-plugin';
import type { Registry } from '@digitalcredentials/verifier-plugin';
import { knownDIDRegistries } from '../lib/verify';

type Credential = Record<string, unknown>;

// A failed download remembers which credential it was for, so the next
// credential asks for the list again instead of going without it until the
// page is reloaded.
type Registries =
  | { state: 'loading' }
  | { state: 'loaded'; list: Registry[] }
  | { state: 'failed'; credential?: Credential };

// The verifier-plugin card: checks a credential in the browser and shows the
// result. Issuers are looked up in the DCC known-registries list, the same list
// the pre-share check uses. The credential is held back until
// that list has loaded (or failed to), so it is checked once, not twice. If the
// list can't be loaded, the card is told so and says our list of known issuers
// didn't load. Left to its own default registry instead, it would call an
// issuer on our list "not on our list of known issuers".
export default function CredentialVerifier({ credential }: { credential?: Credential }) {
  const [registries, setRegistries] = useState<Registries>({ state: 'loading' });
  const loaded = registries.state === 'loaded';

  useEffect(() => {
    if (loaded) return;
    let current = true;
    knownDIDRegistries().then(
      (list) => current && setRegistries({ state: 'loaded', list: list as Registry[] }),
      (err) => {
        console.error('Could not load the known registries:', err);
        if (current) setRegistries({ state: 'failed', credential });
      }
    );
    return () => {
      current = false;
    };
  }, [credential, loaded]);

  // Ready once the list has loaded, or has just failed for this credential.
  const ready = loaded || (registries.state === 'failed' && registries.credential === credential);
  const checking = credential !== undefined && ready;

  return (
    <>
      {/* Always there, empty until needed: a status region that arrives
          already holding its text may never be read out */}
      <p role="status" className="text-sm text-gray-600">
        {credential !== undefined && !ready ? 'Checking…' : ''}
      </p>
      {/* Mounted throughout, but hidden until it has a credential: without
          one, its card is an empty bordered box */}
      <verifier-credential
        registries={loaded ? registries.list : undefined}
        registriesUnavailable={registries.state === 'failed'}
        credential={checking ? credential : undefined}
        style={checking ? undefined : { display: 'none' }}
      />
    </>
  );
}
