import { useEffect, useRef, useState } from 'react';
import * as polyfill from 'credential-handler-polyfill';
import * as WebCredentialHandler from 'web-credential-handler';
import type { CollectionSummary } from '@interop/was-client';
import { runExchange, saveCredential, type ClaimResult } from '../lib/claim';
import { getSessionWASClient } from '../lib/was';
import { isAuthenticated } from '../lib/auth';
import { parsePresentationRequest, matchesAnyExample, type ParsedPresentationRequest } from '../lib/vpRequest';
import { loadWalletCredentials, presentationFor, type WalletCredential } from '../lib/present';
import { credentialName, issuerName } from '../lib/linkedin';

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
  | { step: 'claiming' }
  | { step: 'choose'; claim: ClaimResult; collections: CollectionSummary[] }
  | { step: 'saved'; name: string; collection: string }
  // The verifier-request flow: consent first (naming the requester up front),
  // then a picker over the credentials that match the request
  | { step: 'consent'; origin: string; reasons: string[] }
  | { step: 'loading-credentials' }
  | { step: 'pick'; matches: WalletCredential[] }
  | { step: 'shared' }
  | { step: 'error'; message: string };

function exchangeUrlFrom(vpr: Record<string, unknown> | undefined): string | undefined {
  const interact = vpr?.interact as { service?: { type?: string; serviceEndpoint?: string }[] } | undefined;
  const service = interact?.service?.find((s) =>
    ['VerifiableCredentialApiExchangeService', 'UnmediatedPresentationService2021'].includes(s.type ?? '')
  );
  return service?.serviceEndpoint;
}

export default function ChapiPage() {
  const [phase, setPhase] = useState<Phase>({ step: 'starting' });
  const [collectionId, setCollectionId] = useState('');
  const [saving, setSaving] = useState(false);
  // Resolves the get() hook's promise, handing the issued credential back to
  // the mediator (and closing the popup).
  const resolveRef = useRef<((r: GetResponse) => void) | null>(null);
  const claimRef = useRef<ClaimResult | null>(null);
  const requestRef = useRef<ParsedPresentationRequest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
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

                if (!isAuthenticated() || !(await getSessionWASClient())) {
                  setPhase({ step: 'not-signed-in' });
                  return;
                }
                const exchangeUrl = exchangeUrlFrom(vpr);
                if (!exchangeUrl) {
                  setPhase({ step: 'error', message: 'The request carries no exchange endpoint this wallet understands.' });
                  return;
                }

                setPhase({ step: 'claiming' });
                const claim = await runExchange(exchangeUrl);
                claimRef.current = claim;

                const session = await getSessionWASClient();
                const list = session ? await session.client.space(session.spaceId).collections() : null;
                const collections = (list?.items ?? []).filter((c) => !['Trash', 'dids'].includes(c.id));
                setPhase({ step: 'choose', claim, collections });
                if (collections[0]) {
                  setCollectionId(collections[0].id);
                }
              } catch (err) {
                setPhase({ step: 'error', message: err instanceof Error ? err.message : 'The claim failed.' });
              }
            })();
          });
        },
      });
    })().catch((err) => {
      setPhase({ step: 'error', message: err instanceof Error ? err.message : 'Could not connect to the wallet mediator.' });
    });
  }, []);

  async function save() {
    if (phase.step !== 'choose' || !collectionId || !claimRef.current) {
      return;
    }
    setSaving(true);
    try {
      const credentialName = (claimRef.current.credential.name as string) ?? 'credential';
      const resourceName = `${credentialName.replace(/\s+/g, '-')}-${Date.now()}.json`;
      await saveCredential(collectionId, resourceName, claimRef.current.envelope);
      // Hand the issued presentation back to the issuer page via the mediator
      resolveRef.current?.({
        type: 'response',
        dataType: 'VerifiablePresentation',
        data: claimRef.current.envelope,
      });
      setPhase({ step: 'saved', name: resourceName, collection: collectionId });
    } catch (err) {
      setPhase({ step: 'error', message: err instanceof Error ? err.message : 'Saving failed.' });
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
    if (!isAuthenticated() || !(await getSessionWASClient())) {
      setPhase({ step: 'not-signed-in' });
      return;
    }
    setPhase({ step: 'loading-credentials' });
    try {
      const request = requestRef.current;
      const all = await loadWalletCredentials();
      const matches = request ? all.filter(({ credential }) => matchesAnyExample(credential, request)) : [];
      // A single match starts selected; a list starts empty for an explicit choice
      setSelected(new Set(matches.length === 1 ? [`${matches[0].collectionId}/${matches[0].resourceId}`] : []));
      setPhase({ step: 'pick', matches });
    } catch (err) {
      setPhase({ step: 'error', message: err instanceof Error ? err.message : 'Could not load your credentials.' });
    }
  }

  function toggleSelected(key: string) {
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

  // Share the selection: build the response presentation (signed as the
  // holder when the request asked for DIDAuthentication with a challenge and
  // the holder key is stored; unsigned otherwise) and hand it to the mediator.
  async function share() {
    if (phase.step !== 'pick' || !requestRef.current || selected.size === 0) {
      return;
    }
    setSharing(true);
    try {
      const chosen = phase.matches
        .filter(({ collectionId, resourceId }) => selected.has(`${collectionId}/${resourceId}`))
        .map(({ credential }) => credential);
      const vp = await presentationFor({
        credentials: chosen,
        didAuth: requestRef.current.didAuth,
        challenge: requestRef.current.challenge,
        domain: requestRef.current.domain,
      });
      resolveRef.current?.({ type: 'response', dataType: 'VerifiablePresentation', data: vp });
      setPhase({ step: 'shared' });
    } catch (err) {
      setPhase({ step: 'error', message: err instanceof Error ? err.message : 'Sharing failed.' });
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md p-8">
        <h1 className="text-xl font-semibold text-gray-800 mb-4">Learner Credential Wallet</h1>

        {phase.step === 'starting' && <p className="text-sm text-gray-500">Waiting for the credential request…</p>}

        {phase.step === 'not-signed-in' && (
          <div>
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              You&#39;re not signed in. Open the wallet in another tab, sign in, then retry.
            </p>
            <button onClick={cancel} className="mt-4 w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
              Close
            </button>
          </div>
        )}

        {phase.step === 'claiming' && <p className="text-sm text-gray-500">Proving your DID to the issuer…</p>}

        {phase.step === 'choose' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              You received <span className="font-medium text-gray-800">{String(phase.claim.credential.name ?? 'a credential')}</span>,
              issued to a new DID stored in your <span className="font-mono text-xs">dids</span> collection.
            </p>
            <div>
              <label htmlFor="collection" className="block text-sm font-medium text-gray-700 mb-1">
                Save to collection
              </label>
              {phase.collections.length > 0 ? (
                <select
                  id="collection"
                  value={collectionId}
                  onChange={(e) => setCollectionId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {phase.collections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name ?? c.id}</option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-500">
                  Your space has no collections yet — create one in the wallet first.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={cancel} className="flex-1 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !collectionId}
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
              Saved {phase.name} to {phase.collection}. You can close this window.
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
          <p className="text-sm text-gray-500">Finding credentials that match the request…</p>
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
                              {issuerName(credential) ?? 'Unnamed issuer'} · {collectionId}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex gap-2">
                  <button onClick={cancel} className="flex-1 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
                    Cancel
                  </button>
                  <button
                    onClick={share}
                    disabled={sharing || selected.size === 0}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2"
                  >
                    {sharing ? 'Sharing…' : `Share ${selected.size || ''} Selected`.replace('  ', ' ')}
                  </button>
                </div>
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
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {phase.message}
            </p>
            <button onClick={cancel} className="mt-4 w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
