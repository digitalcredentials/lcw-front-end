import { test, expect } from '@playwright/test';
import { assertPasskey, registerPasskey, PasskeyUnsupportedError } from '../src/lib/identity/passkey';

// Node-side unit assertions over the PRF output a passkey ceremony reads; no
// browser involved. navigator.credentials is stood in for, answering with
// the PRF output each case gives.

const bytes = (length: number) => Array.from({ length }, (_, i) => i);

const credentialWith = (prf: unknown) => ({
  rawId: new Uint8Array([1, 2, 3]).buffer,
  getClientExtensionResults: () => ({ prf }),
});

// Node's own navigator, put back after each test so no other test in the
// same worker sees the stand-in
const nodeNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
test.afterEach(() => {
  if (nodeNavigator) {
    Object.defineProperty(globalThis, 'navigator', nodeNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

function answerWith(first: unknown, created?: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        create: async () => credentialWith(created),
        get: async () => credentialWith({ results: first === undefined ? undefined : { first } }),
      },
    },
  });
}

test('accepts 32 bytes as a plain array (1Password), a buffer or a view', async () => {
  const expected = Uint8Array.from(bytes(32));
  for (const first of [bytes(32), expected.slice().buffer, expected.slice()]) {
    answerWith(first);
    expect((await assertPasskey()).prfOutput).toEqual(expected);
  }
  // A view reads only its own bytes, not the whole buffer behind it
  answerWith(new Uint8Array(Uint8Array.from(bytes(64)).buffer, 16, 32));
  expect((await assertPasskey()).prfOutput).toEqual(Uint8Array.from(bytes(64).slice(16, 48)));
});

test('refuses any output that is not 32 bytes as unusable with this wallet', async () => {
  const refused: unknown[] = [
    undefined,
    [],
    new ArrayBuffer(0),
    bytes(16),
    bytes(64),
    [...bytes(31), 256],
    [...bytes(31), -1],
    [...bytes(31), 1.5],
    [...bytes(31), '1'],
    'x'.repeat(32),
    { ...bytes(32), length: 32 },
    42,
  ];
  for (const first of refused) {
    answerWith(first);
    await expect(assertPasskey(), JSON.stringify(first)).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  }
});

test('a passkey created without a PRF output gets one by signing in once', async () => {
  answerWith(bytes(32), { enabled: true });
  expect((await registerPasskey({ email: 'a@example.org', rpName: 'Wallet' })).prfOutput).toEqual(Uint8Array.from(bytes(32)));
  // An authenticator that says it can't evaluate the PRF is refused outright
  answerWith(bytes(32), { enabled: false });
  await expect(registerPasskey({ email: 'a@example.org', rpName: 'Wallet' })).rejects.toBeInstanceOf(PasskeyUnsupportedError);
});
