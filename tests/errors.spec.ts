import { test, expect } from '@playwright/test';
import { mapError, EncryptionError, ValidationError, WasServerError } from '@interop/was-client';
import { describeError, isSessionEnded, CollectionExistsError, CredentialMissingError } from '../src/lib/errors';

// Node-side unit assertions over the sentence each failure gets; no browser
// involved. Storage failures are built with the WAS client's own mapError,
// from the shapes its HTTP layer throws, so they carry what the page would
// see.

const offline = () => mapError(new TypeError('Failed to fetch'));
const timedOut = () => mapError(Object.assign(new Error('Request timed out: GET https://was.example/space/s/'), { name: 'TimeoutError' }));
const status = (code: number) => mapError({ status: code, message: `Request failed with status code ${code}` });
const COUPON_REQUIRED = 'https://github.com/digitalcredentials/was-server-aws#coupon-required';
const couponRequired = () =>
  Object.assign(new Error('Request failed with status code 403'), { status: 403, data: { type: COUPON_REQUIRED } });

test.beforeEach(() => {
  console.error = () => {};
});

test('a missing session is signed out; a 401 from storage is not', () => {
  expect(isSessionEnded(new Error('UNAUTHORIZED'))).toBe(true);
  expect(describeError('load-spaces', new Error('UNAUTHORIZED')).text).toBe("You've been signed out. Sign in again to keep going.");
  // The storage server answers a session it no longer accepts as 404 or an
  // empty listing, never 401, so a 401 is no sign of one
  expect(isSessionEnded(status(401))).toBe(false);
  expect(describeError('load-spaces', status(401)).text).toBe("We couldn't load your spaces. Please try again.");
});

test('no answer on a read says the storage did not respond', () => {
  // The signed-request HTTP client's own messages, as thrown and as wrapped
  const httpNetwork = new TypeError('Failed to fetch "https://was.example/space/s/". Possible CORS error.');
  const httpTimeout = new Error('Request to "https://was.example/space/s/" timed out.');
  for (const error of [httpNetwork, httpTimeout, mapError(httpNetwork), mapError(httpTimeout)]) {
    expect(describeError('load-collections', error).text).toContain("Your storage didn't respond.");
  }
  const text = "We couldn't load this collection. Your storage didn't respond. Check your connection, or try again in a few minutes.";
  expect(describeError('load-credentials', offline()).text).toBe(text);
  expect(describeError('load-credentials', timedOut()).text).toBe(text);
  // ezcap's own fetch failure, unwrapped
  expect(describeError('load-spaces', new TypeError('Failed to fetch')).text).toContain("Your storage didn't respond.");
  expect(describeError('load-spaces', mapError(new TypeError('NetworkError when attempting to fetch resource.'))).text).toContain("Your storage didn't respond.");
  expect(describeError('load-spaces', mapError(new TypeError('Load failed'))).text).toContain("Your storage didn't respond.");
  // A TypeError from the wallet's own code is no network failure
  expect(describeError('load-spaces', mapError(new TypeError("Failed to construct 'URL': Invalid URL"))).text).toBe("We couldn't load your spaces. Please try again.");
  expect(describeError('load-spaces', new TypeError("Cannot read properties of undefined (reading 'items')")).text).toBe("We couldn't load your spaces. Please try again.");
});

test('a server fault on a read says to try again in a few minutes', () => {
  expect(describeError('load-collections', status(503)).text).toBe("We couldn't load your collections. Your storage had a problem. Try again in a few minutes.");
  expect(describeError('open', status(500)).text).toBe("We couldn't open this credential. Your storage had a problem. Try again in a few minutes.");
  // A gateway timeout answered, so it is a fault, not "didn't respond"
  expect(describeError('load-spaces', mapError({ status: 504, message: 'Endpoint request timed out' })).text).toBe("We couldn't load your spaces. Your storage had a problem. Try again in a few minutes.");
  expect(describeError('load-spaces', new WasServerError('Internal error')).text).toBe("We couldn't load your spaces. Your storage had a problem. Try again in a few minutes.");
});

test('a write that may have stored a copy says to check before trying again', () => {
  expect(describeError('upload', offline()).text).toBe("We can't tell whether this credential was added. Check before trying again.");
  expect(describeError('upload', timedOut()).text).toBe("We can't tell whether this credential was added. Check before trying again.");
  expect(describeError('upload', status(502)).text).toBe("We can't tell whether this credential was added. Check before trying again.");
  // A refusal of a single write is an answer: nothing was stored
  expect(describeError('upload', status(400)).text).toBe("We couldn't add this credential. Please try again.");
  // Writes in several steps can fail after one went through, so any failure
  expect(describeError('delete', status(400)).text).toBe("We can't tell whether this credential was deleted. Check before trying again.");
  expect(describeError('move', status(404)).text).toBe("We can't tell whether this credential was moved. Check before trying again.");
  expect(describeError('restore', offline()).text).toBe("We can't tell whether this credential was restored. Check before trying again.");
  expect(describeError('create-collection', status(412)).text).toBe("We can't tell whether the collection was created. Check before trying again.");
  expect(describeError('create-space', status(403)).text).toBe("We can't tell whether the space was created. Check before trying again.");
  // Writing a description again is safe
  expect(describeError('save-description', offline()).text).toBe("We couldn't save the description. Your storage didn't respond. Check your connection, or try again in a few minutes.");
});

test('a credential the storage returns nothing for may have been moved or deleted', () => {
  const missing = new CredentialMissingError('The storage returned nothing for this credential.');
  for (const action of ['open', 'move', 'restore'] as const) {
    expect(describeError(action, missing).text).toBe("We couldn't find this credential. It may have been moved or deleted.");
  }
});

test("a collection name the storage won't take says to choose another", () => {
  const text = "That name can't be used for a collection. Choose a different name.";
  expect(describeError('create-collection', new ValidationError('Cannot use reserved path segment "export" as a collection id.')).text).toBe(text);
  for (const problem of ['reserved-id', 'invalid-id', 'id-conflict']) {
    const refused = mapError({ status: problem === 'invalid-id' ? 400 : 409, data: { type: `https://w3id.org/pws#${problem}` } });
    expect(describeError('create-collection', refused).text).toBe(text);
  }
  // Another ValidationError, or the same refusal elsewhere, isn't about the name
  expect(describeError('create-collection', new ValidationError('Bad body')).text).toBe("We can't tell whether the collection was created. Check before trying again.");
  expect(describeError('upload', mapError({ status: 409, data: { type: 'https://w3id.org/pws#id-conflict' } })).text).toBe("We couldn't add this credential. Please try again.");
});

test('a name clash is named only for a new collection', () => {
  const clash = new CollectionExistsError('The collection "Work" exists and is not encrypted.');
  expect(describeError('create-collection', clash).text).toBe('You already have a collection with this name. Choose a different name.');
  expect(describeError('upload', clash).text).toBe("We couldn't add this credential. Please try again.");
});

test("an account whose coupon is used up can't create a space", () => {
  expect(describeError('create-space', couponRequired()).text).toBe("We couldn't create the space. Your account can't create more spaces right now.");
  // The coupon problem on any other status is not the coupon refusal
  const couponOn400 = Object.assign(new Error('x'), { status: 400, data: { type: COUPON_REQUIRED } });
  expect(describeError('create-space', couponOn400).text).toBe("We can't tell whether the space was created. Check before trying again.");
});

test('anything else names the action and says to try again', () => {
  const unreadable = new EncryptionError('Cannot determine whether collection s/Work is encrypted');
  expect(describeError('open', unreadable).text).toBe("We couldn't open this credential. Please try again.");
  expect(describeError('save-description', 'a string').text).toBe("We couldn't save the description. Please try again.");
});

test('the technical detail keeps the error name, message and status', () => {
  expect(describeError('load-collections', status(503)).detail).toBe('WasServerError: Request failed with status code 503 (HTTP 503)');
  expect(describeError('open', new CredentialMissingError('gone')).detail).toBe('CredentialMissingError: gone');
});

test('the console gets the summary, not the request the error carries', () => {
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(...args);
  // An HTTP client's error keeps the request it sent, body included
  const error = mapError(Object.assign(new Error('Request failed with status code 500'), {
    status: 500,
    options: { json: { coupon: 'registration-token' } },
  }));
  describeError('create-space', error);
  expect(logged).toEqual(['Wallet: create-space failed: WasServerError: Request failed with status code 500 (HTTP 500)']);
});
