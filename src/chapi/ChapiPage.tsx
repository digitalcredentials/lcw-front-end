import { useEffect, useRef, useState } from 'react';
import Brand from '../components/Brand';
import * as polyfill from 'credential-handler-polyfill';
import * as WebCredentialHandler from 'web-credential-handler';
import { runExchange, saveCredential, type ClaimResult } from '../lib/claim';
import { getSessionWASClient } from '../lib/was';
import { isAuthenticated } from '../lib/auth';
import { loginWithPassphrase, loginWithPasskey, passkeySupported, setSession } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import PasswordInput from '../components/PasswordInput';
import LoadingLabel from '../components/LoadingLabel';
import { normalizeTags } from '../lib/credentials';
import { parsePresentationRequest, matchesAnyExample, type ParsedPresentationRequest } from '../lib/vpRequest';
import { loadWalletCredentials, presentationFor, type WalletCredential } from '../lib/present';
import { credentialName, issuerName } from '../lib/linkedin';
import { verifyForSharing } from '../lib/verify';
import { suggestTag } from '../lib/collectionName';
import FailureText from '../components/FailureText';
import { describeError, isSessionEnded, PlainError, type Failure, type WalletAction } from '../lib/errors';

// The window CHAPI opens when this wallet is chosen. Two kinds of request
// arrive at the get() hook: an issuer's exchange (interact.service endpoint —
// the claim flow, which asks which collection to save the issued credential
// into), and a verifier's presentation request (a QueryByExample asking this
// wallet FOR credentials — the consent + picker flow, which returns the
// user's selection as a presentation). The hook returns a promise that
// resolves once the user acts, which keeps the mediator popup open until
// then.

type GetResponse = { type: 'response'; dataType: string; data: unknown };

type Phase =
  | { step: 'starting' }
  | { step: 'not-signed-in' }
  // `from` is the requesting site's host, named while the claim runs
  | { step: 'claiming'; from: string }
  // The issued credential, shown with the tags it will be saved under
  | { step: 'choose'; claim: ClaimResult }
  | { step: 'saved'; credential: string; tags: string[] }
  // The verifier-request flow: consent first (naming the requester up front),
  // then a picker over the credentials that match the request
  | { step: 'consent'; origin: string; reasons: string[] }
  | { step: 'loading-credentials' }
  | { step: 'pick'; matches: WalletCredential[] }
  | { step: 'shared' }
  | { step: 'error'; failure: Failure };

function exchangeUrlFrom(vpr: Record<string, unknown> | undefined): string | undefined {
  const interact = vpr?.interact as { service?: { type?: string; serviceEndpoint?: string }[] } | undefined;
  const service = interact?.service?.find((s) =>
    ['VerifiableCredentialApiExchangeService', 'UnmediatedPresentationService2021'].includes(s.type ?? '')
  );
  return service?.serviceEndpoint;
}

// The requesting origin's host ("issuer.example.org"), or '' when unknown.
function hostOf(origin: string | undefined): string {
  try {
    return origin ? new URL(origin).host : '';
  } catch {
    return '';
  }
}

// Sentinel select value: the user wants to type a new collection name.
// Whether this pop-up has a session it can use. A pop-up is a window of its
// own, so it has none of the main tab's: the user signs in here, with a
// password or a passkey.
async function signedIn(): Promise<boolean> {
  return isAuthenticated() && Boolean(await getSessionWASClient());
}

export default function ChapiPage() {
  const [phase, setPhase] = useState<Phase>({ step: 'starting' });
  // The tags the credential is saved under, as typed: comma-separated,
  // pre-filled with the category its type suggests
  const [tagsDraft, setTagsDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // A failed save, shown on the save step: the issued credential is still
  // held, so Save can be pressed again
  const [saveError, setSaveError] = useState<Failure | null>(null);
  // Resolves the get() hook's promise, handing the issued credential back to
  // the mediator (and closing the popup).
  const resolveRef = useRef<((r: GetResponse) => void) | null>(null);
  const claimRef = useRef<ClaimResult | null>(null);
  const requestRef = useRef<ParsedPresentationRequest | null>(null);
  // An issuer's exchange that arrived before the user signed in here: the
  // popup has a session of its own (sessionStorage is per window), so it
  // signs the user in itself and then resumes the claim.
  const pendingClaimRef = useRef<{ vpr: Record<string, unknown> | undefined; origin: string | undefined } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Verification failures for the current selection; the user may share anyway
  const [shareWarnings, setShareWarnings] = useState<{ name: string; problems: string[] }[] | null>(null);
  const activatedRef = useRef(false);

  useEffect(() => {
    if (activatedRef.current) {
      return;
    }
    activatedRef.current = true;

    (async () => {
      await polyfill.loadOnce();
      await WebCredentialHandler.activateHandler({
        async get({ event }: { event: {
          credentialRequestOptions?: { web?: { VerifiablePresentation?: Record<string, unknown> } };
          credentialRequestOrigin?: string;
        } }) {
          return new Promise<GetResponse>((resolve) => {
            resolveRef.current = resolve;
            (async () => {
              try {
                const vpr = event.credentialRequestOptions?.web?.VerifiablePresentation;

                // A verifier asking FOR credentials: consent comes first, and
                // it says up front who is asking and that credentials are
                // being requested (the mobile wallet's prompt does not).
                const request = parsePresentationRequest(vpr);
                if (request) {
                  requestRef.current = request;
                  setPhase({
                    step: 'consent',
                    origin: event.credentialRequestOrigin ?? '',
                    reasons: request.reasons,
                  });
                  return;
                }

                pendingClaimRef.current = { vpr, origin: event.credentialRequestOrigin };
                if (!(await signedIn())) {
                  setPhase({ step: 'not-signed-in' });
                  return;
                }
                await claimFrom(vpr, event.credentialRequestOrigin);
              } catch (err) {
                fail('claim', err);
              }
            })();
          });
        },
      });
    })().catch((err) => {
      fail('connect-mediator', err);
    });
  }, []);

  // Runs an issuer's exchange and moves on to the save picker.
  async function claimFrom(vpr: Record<string, unknown> | undefined, origin: string | undefined) {
    const exchangeUrl = exchangeUrlFrom(vpr);
    if (!exchangeUrl) {
      throw new PlainError(
        "This wallet can't collect a credential from this kind of request. Go back to the issuer's page and try another way.",
        'The request carries no exchange endpoint this wallet understands.',
      );
    }
    setPhase({ step: 'claiming', from: hostOf(origin) });
    const claim = await runExchange(exchangeUrl);
    claimRef.current = claim;
    await loadSaveStep(claim);
  }

  // Shows a failure in the popup. With no session while loading the
  // credentials to share, it goes back to the sign-in step, which picks the
  // request up again; a claim cannot resume (the issuer's exchange is usually
  // single-use), so its message says to start again.
  function fail(action: WalletAction, err: unknown) {
    if (action === 'load-for-share' && isSessionEnded(err)) {
      setPhase({ step: 'not-signed-in' });
      return;
    }
    setPhase({ step: 'error', failure: describeError(action, err) });
  }

  // Signed in inside the popup: pick up whichever flow was waiting.
  async function resumeAfterSignIn() {
    const action = requestRef.current ? 'load-for-share' : 'claim';
    try {
      if (requestRef.current) {
        await continueRequest();
      } else if (pendingClaimRef.current) {
        await claimFrom(pendingClaimRef.current.vpr, pendingClaimRef.current.origin);
      }
    } catch (err) {
      fail(action, err);
    }
  }

  // Offers the issued credential for saving, with the tag its type suggests.
  // Called once the claim has run; Save never re-runs the exchange, since
  // the credential is already issued.
  function loadSaveStep(claim: ClaimResult) {
    setTagsDraft(suggestTag(claim.credential));
    setSaveError(null);
    setPhase({ step: 'choose', claim });
  }

  async function save() {
    if (phase.step !== 'choose' || !claimRef.current) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const tags = normalizeTags(tagsDraft.split(','));
      const displayName = credentialName(claimRef.current.credential);
      await saveCredential({ tags, envelope: claimRef.current.envelope });
      // Hand the issued presentation back to the issuer page via the mediator
      resolveRef.current?.({
        type: 'response',
        dataType: 'VerifiablePresentation',
        data: claimRef.current.envelope,
      });
      setPhase({ step: 'saved', credential: displayName, tags });
    } catch (err) {
      if (isSessionEnded(err)) {
        fail('save-claim', err);
      } else {
        setSaveError(describeError('save-claim', err));
      }
    } finally {
      setSaving(false);
    }
  }

  // Closing the window makes the mediator return null to the requesting page.
  function cancel() {
    window.close();
  }

  // Consent given: gate on sign-in, then offer the credentials that match the
  // request's examples.
  async function continueRequest() {
    // The session check reaches the storage server too, so it fails like the
    // loading after it rather than leaving Continue doing nothing
    try {
      if (!(await signedIn())) {
        setPhase({ step: 'not-signed-in' });
        return;
      }
      setPhase({ step: 'loading-credentials' });
      const request = requestRef.current;
      const all = await loadWalletCredentials();
      const matches = request ? all.filter(({ credential }) => matchesAnyExample(credential, request)) : [];
      // A single match starts selected; a list starts empty for an explicit choice
      setSelected(new Set(matches.length === 1 ? [`${matches[0].collectionId}/${matches[0].resourceId}`] : []));
      setPhase({ step: 'pick', matches });
    } catch (err) {
      fail('load-for-share', err);
    }
  }

  function toggleSelected(key: string) {
    // A changed selection invalidates any verification warnings shown for it
    setShareWarnings(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function selectedCredentials(): WalletCredential[] {
    if (phase.step !== 'pick') {
      return [];
    }
    return phase.matches.filter(({ collectionId, resourceId }) =>
      selected.has(`${collectionId}/${resourceId}`)
    );
  }

  // First step of sharing: verify every selected credential (verifier-core,
  // the same checks VerifierPlus runs). Failures show a warning the user may
  // share past; nothing is sent until then.
  async function share() {
    if (phase.step !== 'pick' || !requestRef.current || selected.size === 0) {
      return;
    }
    setVerifying(true);
    try {
      const chosen = selectedCredentials();
      const results = await Promise.all(chosen.map(({ credential }) => verifyForSharing(credential)));
      const warnings = chosen.flatMap(({ credential }, index) =>
        results[index].ok ? [] : [{ name: credentialName(credential), problems: results[index].problems }]
      );
      if (warnings.length) {
        setShareWarnings(warnings);
        return;
      }
    } finally {
      setVerifying(false);
    }
    await send();
  }

  // Build the response presentation (signed as the holder when the request
  // asked for DIDAuthentication with a challenge and the holder key is
  // stored; unsigned otherwise) and hand it to the mediator.
  async function send() {
    if (!requestRef.current) {
      return;
    }
    setSharing(true);
    try {
      const chosen = selectedCredentials().map(({ credential }) => credential);
      const vp = await presentationFor({
        credentials: chosen,
        didAuth: requestRef.current.didAuth,
        challenge: requestRef.current.challenge,
        domain: requestRef.current.domain,
      });
      resolveRef.current?.({ type: 'response', dataType: 'VerifiablePresentation', data: vp });
      setPhase({ step: 'shared' });
    } catch (err) {
      fail('share', err);
    } finally {
      setSharing(false);
    }
  }

  // The issuer named on a just-received credential, for the save step
  const receivedFrom = phase.step === 'choose' ? issuerName(phase.claim.credential) : null;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8">
        <div className="mb-5"><Brand /></div>

        {phase.step === 'starting' && <p className="text-sm"><LoadingLabel label="Waiting for the credential request…" /></p>}

        {phase.step === 'not-signed-in' && (
          <PopupSignIn onSignedIn={resumeAfterSignIn} onCancel={cancel} />
        )}

        {phase.step === 'claiming' && (
          <p className="text-sm">
            <LoadingLabel label={phase.from ? `Getting your credential from ${phase.from}…` : 'Getting your credential…'} />
          </p>
        )}

        {phase.step === 'choose' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You received <span className="font-medium text-gray-800">{credentialName(phase.claim.credential)}</span>
              {receivedFrom ? ` from ${receivedFrom}` : ''}.
            </p>
            <div>
              <label htmlFor="tags" className="block text-sm font-medium text-gray-700 mb-1">
                Tags
              </label>
              <input
                id="tags"
                type="text"
                value={tagsDraft}
                onChange={(e) => {
                  setTagsDraft(e.target.value);
                  setSaveError(null);
                }}
                placeholder="e.g. Degrees, University of Toronto"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-500">Separate tags with commas. You can change them later in the wallet.</p>
            </div>
            {saveError && (
              <div role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <FailureText failure={saveError} />
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={cancel} className="flex-1 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {phase.step === 'saved' && (
          <div>
            <p role="status" className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Saved {phase.credential}{phase.tags.length ? ` with the ${phase.tags.length === 1 ? 'tag' : 'tags'} ${phase.tags.join(', ')}` : ''}. You can close this window.
            </p>
            <button onClick={() => window.close()} className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2">
              Done
            </button>
          </div>
        )}

        {phase.step === 'consent' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              <span className="font-semibold text-gray-900">{phase.origin || 'A website'}</span>{' '}
              is requesting credentials from your wallet.
            </p>
            {phase.reasons.map((reason) => (
              <p key={reason} className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                Reason given: “{reason}”
              </p>
            ))}
            <p className="text-sm text-gray-500">
              If you continue, you will choose which credentials to share. Nothing
              is shared until you confirm your selection.
            </p>
            <div className="flex gap-2">
              <button onClick={cancel} className="flex-1 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                Decline
              </button>
              <button onClick={continueRequest} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2">
                Continue
              </button>
            </div>
          </div>
        )}

        {phase.step === 'loading-credentials' && (
          <p className="text-sm"><LoadingLabel label="Finding credentials that match the request…" /></p>
        )}

        {phase.step === 'pick' && (
          <div className="space-y-4">
            {phase.matches.length === 0 ? (
              <>
                <p className="text-sm text-gray-600">
                  None of your credentials match this request.
                </p>
                <button onClick={cancel} className="w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                  Close
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-600">Select credentials to share.</p>
                <ul className="space-y-2 max-h-64 overflow-y-auto">
                  {phase.matches.map(({ collectionId, resourceId, credential }) => {
                    const key = `${collectionId}/${resourceId}`;
                    return (
                      <li key={key}>
                        <label className="flex items-start gap-3 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleSelected(key)}
                            className="mt-1"
                          />
                          <span>
                            <span className="block text-sm font-medium text-gray-800">
                              {credentialName(credential)}
                            </span>
                            <span className="block text-xs text-gray-500">
                              {issuerName(credential) ?? 'Unnamed issuer'}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {shareWarnings ? (
                  <div role="alert" className="bg-amber-50 border-2 border-amber-300 rounded-lg p-3 space-y-3">
                    <p className="text-sm font-semibold text-amber-800">
                      Some selected credentials do not fully verify:
                    </p>
                    <ul className="space-y-1">
                      {shareWarnings.map(({ name, problems }) => (
                        <li key={name} className="text-xs text-amber-800">
                          <span className="font-medium">{name}</span>: {problems.join('; ')}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-amber-800">
                      Whoever receives them may not accept them. Share anyway?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShareWarnings(null)}
                        disabled={sharing}
                        className="flex-1 border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2"
                      >
                        Back
                      </button>
                      <button
                        onClick={send}
                        disabled={sharing}
                        className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white font-medium text-sm rounded-lg px-4 py-2"
                      >
                        {sharing ? 'Sharing…' : 'Share Anyway'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={cancel} className="flex-1 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                      Cancel
                    </button>
                    <button
                      onClick={share}
                      disabled={sharing || verifying || selected.size === 0}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2"
                    >
                      {verifying ? 'Verifying…' : sharing ? 'Sharing…' : `Share ${selected.size || ''} Selected`.replace('  ', ' ')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {phase.step === 'shared' && (
          <div>
            <p role="status" className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Credentials shared. You can close this window.
            </p>
            <button onClick={() => window.close()} className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2">
              Done
            </button>
          </div>
        )}

        {phase.step === 'error' && (
          <div>
            <div role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <FailureText failure={phase.failure} />
            </div>
            <button onClick={cancel} className="mt-4 w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// The popup's own sign-in: this window holds no session of the wallet's
// (sessionStorage is per window), so the user signs in here with the same
// email and passphrase, and the waiting flow resumes.
function PopupSignIn({ onSignedIn, onCancel }: { onSignedIn: () => Promise<void>; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const session = await loginWithPassphrase({ email, passphrase: password, config: identityConfig() });
      setSession(session);
      await onSignedIn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 400 || status === 401 ? 'Invalid email or password.' : 'Unable to sign in. Please try again.');
      setLoading(false);
    }
  }

  async function handlePasskey() {
    setError('');
    setLoading(true);
    try {
      setSession(await loginWithPasskey({ config: identityConfig() }));
      await onSignedIn();
    } catch (err) {
      console.error('Passkey sign-in failed:', err);
      setError('Unable to sign in with a passkey. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      <p className="text-sm text-gray-700">Sign in to continue.</p>
      {passkeySupported() && (
        <button
          type="button"
          onClick={handlePasskey}
          disabled={loading}
          className="w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2"
        >
          Sign in with a passkey
        </button>
      )}
      <div>
        <label htmlFor="chapi-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
        <input
          id="chapi-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>
      <div>
        <label htmlFor="chapi-password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <PasswordInput id="chapi-password" autoComplete="current-password" value={password} onChange={setPassword} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2"
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
      <button type="button" onClick={onCancel} className="w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
        Close
      </button>
    </form>
  );
}
