import * as polyfill from 'credential-handler-polyfill';
import * as WebCredentialHandler from 'web-credential-handler';

const CREDENTIAL_HANDLER = { name: 'credentialhandler' };

type Permissions = {
  query: (desc: { name: string }) => Promise<{ state: string }>;
  revoke: (desc: { name: string }) => Promise<{ state: string }>;
};

function permissions(): Permissions {
  return (navigator as unknown as { credentialsPolyfill: { permissions: Permissions } })
    .credentialsPolyfill.permissions;
}

// The silent permission query runs in the mediator's hidden third-party
// iframe, whose storage modern browsers partition away from the mediator's
// first-party popup — so the query can report not-granted even while CHAPI
// flows work. This browser-local record of registrations made through this
// app is the fallback source of truth when the query does not say granted.
const REGISTERED_KEY = 'lcw_chapi_registered';

// Registers this wallet with the browser's credential mediator (CHAPI), so
// issuer pages can offer it as a wallet choice. The handler URL and enabled
// types come from public/manifest.json.
export async function registerWallet() {
  await polyfill.loadOnce();
  await WebCredentialHandler.installHandler();
  localStorage.setItem(REGISTERED_KEY, 'true');
}

// Removes the wallet registration by revoking the credentialhandler permission.
export async function unregisterWallet() {
  await polyfill.loadOnce();
  await permissions().revoke(CREDENTIAL_HANDLER);
  localStorage.removeItem(REGISTERED_KEY);
}

// Whether this wallet is registered with the browser: the permission query
// when it positively says granted, else the local record of a registration
// made here. (A registration revoked directly in the mediator's own settings
// would keep showing Enabled until Disable is clicked here — revoking an
// already-absent registration is harmless.)
export async function isWalletEnabled(): Promise<boolean> {
  try {
    await polyfill.loadOnce();
    const status = await permissions().query(CREDENTIAL_HANDLER);
    if (status.state === 'granted') {
      localStorage.setItem(REGISTERED_KEY, 'true');
      return true;
    }
  } catch {
    // fall through to the local record
  }
  return localStorage.getItem(REGISTERED_KEY) === 'true';
}
