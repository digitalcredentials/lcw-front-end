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

// Registers this wallet with the browser's credential mediator (CHAPI), so
// issuer pages can offer it as a wallet choice. The handler URL and enabled
// types come from public/manifest.json.
export async function registerWallet() {
  await polyfill.loadOnce();
  await WebCredentialHandler.installHandler();
}

// Removes the wallet registration by revoking the credentialhandler permission.
export async function unregisterWallet() {
  await polyfill.loadOnce();
  await permissions().revoke(CREDENTIAL_HANDLER);
}

// Whether this origin currently holds the credentialhandler permission.
export async function isWalletEnabled(): Promise<boolean> {
  await polyfill.loadOnce();
  const status = await permissions().query(CREDENTIAL_HANDLER);
  return status.state === 'granted';
}
