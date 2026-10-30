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

// What navigator.credentials.get was asked for, one entry per call
let signIns: CredentialRequestOptions[] = [];

function answerWith(first: unknown, created?: unknown) {
  signIns = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        create: async () => credentialWith(created),
        get: async (options: CredentialRequestOptions) => {
          signIns.push(options);
          return credentialWith({ results: first === undefined ? undefined : { first } });
        },
      },
    },
  });
}

// An array of `length` with no elements at all, or with its last one missing
const holes = (length: number) => new Array(length);
const lastMissing = () => Object.assign(bytes(31), { length: 32 });

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
  const refused: [string, unknown][] = [
    ['missing', undefined],
    ['an empty array', []],
    ['an empty buffer', new ArrayBuffer(0)],
    ['16 bytes', bytes(16)],
    ['64 bytes', bytes(64)],
    ['an array holding 256', [...bytes(31), 256]],
    ['an array holding -1', [...bytes(31), -1]],
    ['an array holding a fraction', [...bytes(31), 1.5]],
    ['an array holding a string', [...bytes(31), '1']],
    ['32 holes', holes(32)],
    ['an array missing its last byte', lastMissing()],
    ['a string', 'x'.repeat(32)],
    ['an array-like object', { ...bytes(32), length: 32 }],
    ['a number', 42],
  ];
  for (const [what, first] of refused) {
    answerWith(first);
    await expect(assertPasskey(), what).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  }
});

const register = () => registerPasskey({ email: 'a@example.org', rpName: 'Wallet' });

test('a passkey whose creation gives the output keeps it, without signing in', async () => {
  answerWith(bytes(32).reverse(), { results: { first: bytes(32) } });
  expect((await register()).prfOutput).toEqual(Uint8Array.from(bytes(32)));
  expect(signIns).toHaveLength(0);
  // An unusable output at creation is refused, not traded for a sign-in
  answerWith(bytes(32), { results: { first: bytes(16) } });
  await expect(register()).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  expect(signIns).toHaveLength(0);
});

test('a passkey created without a PRF output gets one by signing in once, with that passkey', async () => {
  for (const created of [{ enabled: true }, undefined]) {
    answerWith(bytes(32), created);
    const { credentialId, prfOutput } = await register();
    expect(prfOutput).toEqual(Uint8Array.from(bytes(32)));
    expect(signIns).toHaveLength(1);
    const allowed = signIns[0].publicKey?.allowCredentials ?? [];
    expect(allowed.map((c) => Array.from(c.id as Uint8Array))).toEqual([Array.from(credentialId)]);
  }
  // An authenticator that says it can't evaluate the PRF is refused outright
  answerWith(bytes(32), { enabled: false });
  await expect(register()).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  expect(signIns).toHaveLength(0);
});
