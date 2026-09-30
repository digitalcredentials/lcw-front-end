import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ResourceSummary, CollectionSummary, ResourceData } from '@interop/was-client';
import '@digitalcredentials/veri-good';
import type { VeriGoodElement } from '../types/veri-good';
import { getToken, clearToken, getSpaceUrl } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
import { registerWallet, unregisterWallet, isWalletEnabled } from '../lib/chapi';
import UploadCredentialModal from '../components/UploadCredentialModal';
import ShareCredentialModal from '../components/ShareCredentialModal';
import JSONInput from '../components/JSONInput';
import {
  credentialFrom,
  credentialName,
  issuerName,
  credentialIssuance,
  credentialExpiration,
  credentialImage,
  issuerImage,
  type CredentialLike,
} from '../lib/linkedin';

// The per-row summary extracted from a resource's body in the background,
// shown in the list alongside the file name.
interface RowSummary {
  title: string;
  logo: string | null;
  issuer: string | null;
  issuerLogo: string | null;
  issued: string | null;
  expires: string | null;
}

// Issuers whose credentials the verifier accepts, keyed by DID
const ISSUER_DIDS = {
  'did:key:z6MknNQD1WHLGGraFi6zcbGevuAgkVfdyCdtZnQTGWVVvR5Q': {
    issuerName: 'DCC Demo University',
    url: 'https://digitalcredentials.mit.edu/'
  },
  'did:key:z6MktL8XGbuYv5f7hwf6hVyJkJWynNtNhcsXFYe9NJzjKHkW': {
    issuerName: 'Digital Credentials Consortium',
    url: 'https://digitalcredentials.mit.edu/'
  },
  'did:key:z6MkkCNaxehr7RoeDJQP39oQ1yFbmUg29ziXfLwoyeCo1QFf': {
    issuerName: 'LCW Sandbox Issuer',
    url: 'https://issuer.lcw-sandbox.org'
  }
};

const FILE_ICON = (
  <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const FOLDER_ICON = (
  <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293l1.414 1.414a1 1 0 00.707.293H19a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </svg>
);

export default function FileBrowserPage() {
  const navigate = useNavigate();
  // The client signs with the key pair that authenticated at login, against
  // the space URL the login API returned.
  const session = useMemo(() => getSessionWASClient(), []);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selected, setSelected] = useState<CollectionSummary | null>(null);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [error, setError] = useState('');
  // The opened resource: 'detail' replaces the list with the credential view
  // (formatted contents, source and verification side by side); 'source' is
  // the read-only source-only view used in the Trash and dids collections
  const [viewing, setViewing] = useState<{
    resource: ResourceSummary;
    vc: string;
    mode: 'detail' | 'source';
  } | null>(null);
  // Credential summaries for the list rows, keyed by
  // `${collectionId}/${resourceId}`, fetched in the background after the
  // listing loads
  const [summaries, setSummaries] = useState<Record<string, RowSummary>>({});
  const [deleteTarget, setDeleteTarget] = useState<ResourceSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [shareTarget, setShareTarget] = useState<ResourceSummary | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ResourceSummary | null>(null);
  const [restoreCollectionId, setRestoreCollectionId] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionDescription, setNewCollectionDescription] = useState('');
  // Collection descriptions for the cards, keyed by collection id, fetched in
  // the background from each collection's description document
  const [collectionDescriptions, setCollectionDescriptions] = useState<Record<string, string>>({});
  const [newCollectionName, setNewCollectionName] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [newCollectionError, setNewCollectionError] = useState('');

  // The verifier is mounted once and reused for every verification. It fires
  // veri-good-is-ready synchronously on connect, so it accepts calls as soon
  // as React attaches the ref. The issuer DIDs must go through
  // setIssuerDids(): the component reads a <template> child's .content
  // fragment, which React never populates (it renders template children as
  // ordinary child nodes), so the declarative form silently yields an empty
  // issuer list.
  const verifierRef = useRef<VeriGoodElement | null>(null);
  const handleVerifierRef = useCallback((node: HTMLElement | null) => {
    verifierRef.current = node as VeriGoodElement | null;
    if (node) {
      (node as VeriGoodElement).setIssuerDids(JSON.stringify(ISSUER_DIDS));
    }
  }, []);

  // Turns a failed request into either a redirect to login or a shown message.
  const handleError = useCallback((err: unknown) => {
    if (err instanceof Error && err.message === 'UNAUTHORIZED') {
      clearToken();
      navigate('/login', { replace: true });
    } else {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    }
  }, [navigate]);

  const loadCollections = useCallback(async () => {
    const token = getToken();
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    setLoading(true);
    setError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const collectionList = await s.client.space(s.spaceId).collections();
      const items = collectionList?.items ?? [];
      setCollections(items);

      // Fetch each collection's description document in the background for
      // the card blurbs (the listing itself carries no description)
      void Promise.all(
        items.map(async (item): Promise<[string, string] | null> => {
          try {
            const desc = await s.client.space(s.spaceId).collection(item.id).describe();
            const text = (desc as { description?: unknown } | null)?.description;
            return typeof text === 'string' && text.trim() ? [item.id, text] : null;
          } catch {
            return null;
          }
        })
      ).then((entries) => {
        const found = entries.filter((e): e is [string, string] => e !== null);
        if (found.length) {
          setCollectionDescriptions((current) => ({ ...current, ...Object.fromEntries(found) }));
        }
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session]);

  const loadResources = useCallback(async (collection: CollectionSummary) => {
    const token = getToken();
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }

    setLoading(true);
    setError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const resourceList = await s.client.space(s.spaceId).collection(collection.id).list();
      const items = resourceList?.items ?? [];
      setResources(items);

      // Fetch the bodies in the background to show credential details in the
      // list; entries are keyed by collection so a stale fetch after
      // switching collections is harmless.
      void Promise.all(
        items.map(async (item): Promise<[string, RowSummary] | null> => {
          try {
            const data = await s.client.space(s.spaceId).collection(collection.id).resource(item.id).get();
            const parsed = data instanceof Blob ? JSON.parse(await data.text()) : data;
            const credential = credentialFrom(parsed);
            if (!credential) {
              return null;
            }
            return [`${collection.id}/${item.id}`, {
              title: credentialName(credential),
              logo: credentialImage(credential),
              issuer: issuerName(credential),
              issuerLogo: issuerImage(credential),
              issued: credentialIssuance(credential)?.toLocaleDateString() ?? null,
              expires: credentialExpiration(credential)?.toLocaleDateString() ?? null,
            }];
          } catch {
            return null;
          }
        })
      ).then((entries) => {
        const found = entries.filter((e): e is [string, RowSummary] => e !== null);
        if (found.length) {
          setSummaries((current) => ({ ...current, ...Object.fromEntries(found) }));
        }
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session]);

  // Retrieves a resource through the WAS client (a signed request) and shows
  // it: in the credential detail view (contents, source and verification), or
  // in the read-only source-only viewer (Trash and dids).
  const openResource = useCallback(async (resource: ResourceSummary, mode: 'detail' | 'source') => {
    if (!selected) {
      return;
    }
    setLoading(true);
    setError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const data = await s.client.space(s.spaceId).collection(selected.id).resource(resource.id).get();
      if (data === null) {
        setError('This resource could not be retrieved.');
        return;
      }
      const vc = data instanceof Blob ? await data.text() : JSON.stringify(data);
      setViewing({ resource, vc, mode });
      if (mode === 'detail') {
        verifierRef.current?.verify(vc);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session, selected]);

  // Moves the credential into the space's Trash collection (the WAS DELETE
  // endpoint's soft-delete semantics), then refreshes the list.
  const deleteCredential = useCallback(async (resource: ResourceSummary) => {
    if (!selected) {
      return;
    }
    setDeleting(true);
    setError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      await s.client.space(s.spaceId).collection(selected.id).resource(resource.id).delete();
      setDeleteTarget(null);
      setViewing((v) => (v?.resource.id === resource.id ? null : v));
      await loadResources(selected);
    } catch (err) {
      setDeleteTarget(null);
      handleError(err);
    } finally {
      setDeleting(false);
    }
  }, [navigate, handleError, session, selected, loadResources]);

  // Moves a credential out of Trash into the chosen collection: copy the
  // stored body over, then delete the Trash copy (a DELETE inside Trash is
  // permanent on the server, so this is a move, not another soft delete).
  const restoreCredential = useCallback(async (resource: ResourceSummary, targetCollectionId: string) => {
    if (!selected || !targetCollectionId) {
      return;
    }
    setRestoring(true);
    setError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const space = s.client.space(s.spaceId);
      const data = await space.collection(selected.id).resource(resource.id).get();
      if (data === null) {
        throw new Error('The credential could not be read from Trash.');
      }
      const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
      await space.collection(targetCollectionId).put(resource.id, body as ResourceData);
      await space.collection(selected.id).resource(resource.id).delete();
      setRestoreTarget(null);
      setViewing((v) => (v?.resource.id === resource.id ? null : v));
      await loadResources(selected);
    } catch (err) {
      setRestoreTarget(null);
      handleError(err);
    } finally {
      setRestoring(false);
    }
  }, [navigate, handleError, session, selected, loadResources]);

  // The source shown pretty-printed in the read-only viewer
  const viewingSource = useMemo(() => {
    if (!viewing) {
      return '';
    }
    try {
      return JSON.stringify(JSON.parse(viewing.vc), null, 2);
    } catch {
      return viewing.vc;
    }
  }, [viewing]);

  // The formatted summary shown at the top of the credential detail view
  const viewingSummary = useMemo(() => {
    if (!viewing) {
      return null;
    }
    let credential: CredentialLike | null = null;
    try {
      credential = credentialFrom(JSON.parse(viewing.vc));
    } catch {
      return null;
    }
    if (!credential) {
      return null;
    }
    const subject = credential.credentialSubject as
      | { name?: unknown; hasCredential?: unknown; achievement?: unknown }
      | undefined;
    const achievement = [subject?.hasCredential ?? subject?.achievement ?? []].flat()[0] as
      | { description?: unknown }
      | undefined;
    const description = (credential as { description?: unknown }).description ?? achievement?.description;
    const issuerUrl = (credential.issuer as { url?: unknown } | undefined)?.url;
    return {
      title: credentialName(credential),
      issuer: issuerName(credential),
      issuerUrl: typeof issuerUrl === 'string' ? issuerUrl : null,
      recipient: typeof subject?.name === 'string' ? subject.name : null,
      issued: credentialIssuance(credential),
      expires: credentialExpiration(credential),
      description: typeof description === 'string' ? description : null,
    };
  }, [viewing]);

  // item.url is a path on the WAS server; the share sheet wants it absolute
  const wasOrigin = (getSpaceUrl() ?? '').replace(/\/space\/.*$/, '');

  // Uploads credential JSON (pasted, picked, or dropped) to the selected
  // collection under the given name, then refreshes the resource list.
  const uploadCredential = useCallback(async (name: string, text: string) => {
    if (!selected) {
      return;
    }
    setUploading(true);
    setUploadError('');

    try {
      let credential: unknown;
      try {
        credential = JSON.parse(text);
      } catch {
        setUploadError(`${name} is not valid JSON.`);
        return;
      }

      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      await s.client.space(s.spaceId).collection(selected.id).put(name, credential as ResourceData);
      setUploadOpen(false);
      await loadResources(selected);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setUploading(false);
    }
  }, [navigate, session, selected, loadResources]);

  // Creates a collection named by the user via a PUT of its description (the
  // WAS create-by-id path). The id is the name with whitespace dashed, since
  // it becomes a path segment and an S3 prefix; force acknowledges that
  // configure() cannot read a description that does not exist yet.
  const createCollection = useCallback(async () => {
    const name = newCollectionName.trim();
    if (!name) {
      return;
    }
    setCreatingCollection(true);
    setNewCollectionError('');

    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      // A raw PUT of the full description document (the WAS update-or-create
      // by id operation): the client's configure() helper strips fields it
      // does not know, and `description` is not among its writable fields.
      const description = newCollectionDescription.trim();
      await s.client.request({
        path: `/space/${s.spaceId}/${name.replace(/\s+/g, '-')}`,
        method: 'PUT',
        json: {
          type: ['Collection'],
          name,
          ...(description && { description }),
        },
      });
      setNewCollectionOpen(false);
      setNewCollectionName('');
      setNewCollectionDescription('');
      await loadCollections();
    } catch (err) {
      setNewCollectionError(err instanceof Error ? err.message : 'Could not create the collection.');
    } finally {
      setCreatingCollection(false);
    }
  }, [navigate, session, newCollectionName, newCollectionDescription, loadCollections]);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  function openCollection(collection: CollectionSummary) {
    setSelected(collection);
    setResources([]);
    setViewing(null);
    loadResources(collection);
  }

  function backToCollections() {
    setSelected(null);
    setResources([]);
    setViewing(null);
    setError('');
  }

  function retry() {
    if (selected) {
      loadResources(selected);
    } else {
      loadCollections();
    }
  }

  // 'unknown' until the CHAPI permission is queried; then reflects reality
  const [walletState, setWalletState] = useState<'unknown' | 'enabled' | 'disabled'>('unknown');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);

  useEffect(() => {
    isWalletEnabled()
      .then((enabled) => setWalletState(enabled ? 'enabled' : 'disabled'))
      .catch(() => setWalletState('disabled'));
  }, []);

  async function enableBrowserWallet() {
    setWalletBusy(true);
    try {
      await registerWallet();
      setWalletState('enabled');
    } catch (err) {
      handleError(err);
    } finally {
      setWalletBusy(false);
    }
  }

  async function disableBrowserWallet() {
    setWalletBusy(true);
    setWalletMenuOpen(false);
    try {
      await unregisterWallet();
      setWalletState('disabled');
    } catch (err) {
      handleError(err);
    } finally {
      setWalletBusy(false);
    }
  }

  function handleSignOut() {
    clearToken();
    navigate('/login', { replace: true });
  }

  const isEmpty = selected ? resources.length === 0 : collections.length === 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span>
          <span className="block text-lg font-semibold text-gray-800 leading-tight">
            Digital Credentials Commons
          </span>
          <span className="block text-sm text-gray-500 leading-tight">
            Learner Credential Wallet
          </span>
        </span>
        <div className="flex items-center gap-4">
          <Link
            to="/batches"
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            title="Issue batches of credentials from a CSV"
          >
            Batch issuer
          </Link>
          {walletState === 'enabled' ? (
            <div className="relative">
              <button
                onClick={() => setWalletMenuOpen((o) => !o)}
                disabled={walletBusy}
                className="text-sm text-green-700 hover:text-green-800 transition-colors"
                title="This wallet is registered with your browser (CHAPI). Click to manage."
              >
                {walletBusy ? 'Working…' : 'Browser wallet is enabled ✓'}
              </button>
              {walletMenuOpen && (
                <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-md z-10">
                  <button
                    onClick={disableBrowserWallet}
                    className="w-full text-left text-sm text-red-600 hover:bg-red-50 rounded-lg px-3 py-2"
                  >
                    Disable browser wallet
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={enableBrowserWallet}
              disabled={walletBusy || walletState === 'unknown'}
              className="text-sm text-gray-500 hover:text-gray-700 disabled:text-gray-400 transition-colors"
              title="Register this wallet with your browser so issuer sites can offer it (CHAPI)"
            >
              {walletBusy ? 'Working…' : 'Enable browser wallet'}
            </button>
          )}
          <button
            onClick={handleSignOut}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Breadcrumb and collection actions */}
        <div className="flex items-center justify-between mb-4">
          <nav className="flex items-center gap-2 text-sm" aria-label="Breadcrumb">
            <button
              onClick={backToCollections}
              disabled={!selected}
              className="text-gray-500 hover:text-gray-700 disabled:text-gray-400 disabled:cursor-default transition-colors"
            >
              Collections
            </button>
            {selected && (
              <>
                <span className="text-gray-300" aria-hidden="true">/</span>
                <span className="text-gray-800 font-medium">{selected.name || selected.id}</span>
              </>
            )}
          </nav>
          {selected ? (
            <button
              onClick={() => { setUploadError(''); setUploadOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              Add Credential
            </button>
          ) : (
            <button
              onClick={() => { setNewCollectionError(''); setNewCollectionName(''); setNewCollectionOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              New Collection
            </button>
          )}
        </div>

        {/* States */}
        {loading && (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
            Loading…
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {error}
            <button
              onClick={retry}
              className="ml-3 underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && isEmpty && (
          <p className="text-center text-gray-400 text-sm py-20">
            {selected ? 'This collection is empty.' : 'This space is empty.'}
          </p>
        )}

        {/* Collections */}
        {!loading && !error && !selected && collections.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((item) => (
              <button
                key={item.id}
                onClick={() => openCollection(item)}
                className="flex flex-col items-start gap-2 rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
              >
                <span className="flex items-center gap-2">
                  {FOLDER_ICON}
                  <span className="font-medium text-gray-800">{item.name ?? item.id}</span>
                </span>
                {collectionDescriptions[item.id] && (
                  <span className="text-sm text-gray-500">{collectionDescriptions[item.id]}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Resources in the selected collection, as cards (hidden while a
            credential's detail view is open). File names are not shown; a
            resource without a credential title (a signing key, a non-VC
            upload) falls back to its file name as the card title. */}
        {!loading && !error && selected && resources.length > 0 && viewing?.mode !== 'detail' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {resources.map((item) => {
              const summary = summaries[`${selected.id}/${item.id}`];
              return (
                <div
                  key={item.id}
                  data-resource-id={item.id}
                  className={`flex flex-col gap-3 rounded-xl border p-4 ${
                    viewing?.resource.id === item.id
                      ? 'border-indigo-300 bg-indigo-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {summary?.logo ? (
                      <img
                        src={summary.logo}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <span className="mt-1 shrink-0">{FILE_ICON}</span>
                    )}
                    <span className="font-medium text-gray-800">
                      {summary?.title ?? item.name ?? item.id}
                    </span>
                  </div>
                  {summary?.issuer && (
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      {summary.issuerLogo && (
                        <img
                          src={summary.issuerLogo}
                          alt=""
                          className="h-5 w-5 shrink-0 rounded object-contain"
                        />
                      )}
                      {summary.issuer}
                    </div>
                  )}
                  {(summary?.issued || summary?.expires) && (
                    <p className="text-xs text-gray-500">
                      {summary.issued && <>Issued {summary.issued}</>}
                      {summary.issued && summary.expires && ' · '}
                      {summary.expires && <>Expires {summary.expires}</>}
                    </p>
                  )}
                  <div className="mt-auto flex items-center gap-2 pt-1">
                    {/* A credential opens into the detail view; Trash and
                        dids keep their own source/restore/delete actions */}
                    {!['Trash', 'dids'].includes(selected.id) && (
                      <button
                        onClick={() => openResource(item, 'detail')}
                        className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        Open
                      </button>
                    )}
                    {['Trash', 'dids'].includes(selected.id) && (
                      <button
                        onClick={() => openResource(item, 'source')}
                        className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        View Source
                      </button>
                    )}
                    {selected.id === 'Trash' && (
                      <button
                        onClick={() => {
                          setRestoreTarget(item);
                          setRestoreCollectionId(
                            collections.find((c) => !['Trash', 'dids'].includes(c.id))?.id ?? ''
                          );
                        }}
                        className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        Restore
                      </button>
                    )}
                    {['Trash', 'dids'].includes(selected.id) && (
                      <button
                        onClick={() => setDeleteTarget(item)}
                        className="border border-red-200 hover:bg-red-50 text-red-600 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* Credential detail view: header + formatted summary above, source
            and verification side by side, Share/Delete at the bottom. The
            veri-good element is mounted once and kept in a fixed slot of an
            always-rendered wrapper (keyed, with a placeholder occupying the
            sibling slot) because the component misbehaves when remounted; it
            is hidden with CSS outside detail mode. */}
        {selected && viewing?.mode === 'detail' && (
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-800">
              {viewingSummary?.title ?? viewing.resource.name ?? viewing.resource.id}
            </h2>
            <button
              onClick={() => setViewing(null)}
              className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              Back to list
            </button>
          </div>
        )}

        {selected && viewing?.mode === 'detail' && viewingSummary && (
          <div className="mb-6 bg-white rounded-xl border border-gray-200 p-5">
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2 text-sm">
              {viewingSummary.recipient && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-gray-400">Issued to</dt>
                  <dd className="text-gray-800">{viewingSummary.recipient}</dd>
                </div>
              )}
              {viewingSummary.issuer && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-gray-400">Issuer</dt>
                  <dd className="text-gray-800">
                    {viewingSummary.issuer}
                    {viewingSummary.issuerUrl && (
                      <>
                        {' '}
                        <a
                          href={viewingSummary.issuerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-600 hover:text-indigo-700 text-xs"
                        >
                          {viewingSummary.issuerUrl}
                        </a>
                      </>
                    )}
                  </dd>
                </div>
              )}
              {viewingSummary.issued && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-gray-400">Issued</dt>
                  <dd className="text-gray-800">{viewingSummary.issued.toLocaleDateString()}</dd>
                </div>
              )}
              {viewingSummary.expires && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-gray-400">Expires</dt>
                  <dd className="text-gray-800">{viewingSummary.expires.toLocaleDateString()}</dd>
                </div>
              )}
              {viewingSummary.description && (
                <div className="sm:col-span-2">
                  <dt className="text-xs uppercase tracking-wide text-gray-400">Description</dt>
                  <dd className="text-gray-800">{viewingSummary.description}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <div className={viewing?.mode === 'detail' ? 'grid gap-6 items-start lg:grid-cols-2' : ''}>
          {selected && viewing?.mode === 'detail' ? (
            <section key="source" aria-label="Credential source">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
                Credential Source
              </h2>
              <JSONInput text={viewingSource} readOnly />
            </section>
          ) : (
            <span key="source" className="hidden" />
          )}
          <section
            key="verifier"
            className={selected && viewing?.mode === 'detail' ? '' : 'hidden'}
            aria-label="Credential verification"
          >
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
              Credential Verification
            </h2>
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <veri-good ref={handleVerifierRef} />
            </div>
          </section>
        </div>

        {selected && viewing?.mode === 'detail' && (
          <div className="mt-6 flex gap-2">
            <button
              onClick={() => setShareTarget(viewing.resource)}
              className="border border-gray-300 hover:bg-gray-100 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              Share
            </button>
            <button
              onClick={() => setDeleteTarget(viewing.resource)}
              className="border border-red-200 hover:bg-red-50 text-red-600 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              Delete
            </button>
          </div>
        )}

        {/* Read-only source-only viewer (Trash and dids), below the list */}
        {selected && viewing?.mode === 'source' && (
          <section className="mt-8" aria-label="Credential source">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
                Credential Source
              </h2>
              <span className="text-sm text-gray-600">
                {viewing.resource.name ?? viewing.resource.id}
              </span>
            </div>
            <JSONInput text={viewingSource} readOnly />
          </section>
        )}
      </main>

      {uploadOpen && (
        <UploadCredentialModal
          busy={uploading}
          error={uploadError}
          onClose={() => setUploadOpen(false)}
          onUpload={uploadCredential}
        />
      )}

      {/* Name and create a new collection */}
      {newCollectionOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setNewCollectionOpen(false)}
        >
          <div
            role="dialog"
            aria-label="New Collection"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-4">New Collection</h2>
            <form
              onSubmit={(e) => { e.preventDefault(); createCollection(); }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="collection-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  id="collection-name"
                  type="text"
                  autoFocus
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="e.g. Diplomas"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              <div>
                <label htmlFor="collection-description" className="block text-sm font-medium text-gray-700 mb-1">
                  Description <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <textarea
                  id="collection-description"
                  rows={2}
                  value={newCollectionDescription}
                  onChange={(e) => setNewCollectionDescription(e.target.value)}
                  placeholder="What this collection holds"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {newCollectionError && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {newCollectionError}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNewCollectionOpen(false)}
                  className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingCollection || !newCollectionName.trim()}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {creatingCollection ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm before moving a credential to the Trash collection */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            role="dialog"
            aria-label="Delete Credential"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Delete Credential</h2>
            {/* Inside Trash the server deletes permanently; elsewhere it is a
                soft delete into Trash */}
            {selected?.id === 'Trash' ? (
              <p className="text-sm text-gray-600 mb-5">
                Permanently delete{' '}
                <span className="font-medium text-gray-800">{deleteTarget.name ?? deleteTarget.id}</span>?
                This cannot be undone.
              </p>
            ) : (
              <p className="text-sm text-gray-600 mb-5">
                Move <span className="font-medium text-gray-800">{deleteTarget.name ?? deleteTarget.id}</span> to
                the Trash collection?
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteCredential(deleteTarget)}
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore from Trash: pick the collection the credential moves into */}
      {restoreTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setRestoreTarget(null)}
        >
          <div
            role="dialog"
            aria-label="Restore Credential"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Restore Credential</h2>
            <p className="text-sm text-gray-600 mb-3">
              Move <span className="font-medium text-gray-800">{restoreTarget.name ?? restoreTarget.id}</span> out
              of Trash into:
            </p>
            <label htmlFor="restore-collection" className="sr-only">Collection to restore into</label>
            <select
              id="restore-collection"
              value={restoreCollectionId}
              onChange={(e) => setRestoreCollectionId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-5"
            >
              {collections
                .filter((c) => !['Trash', 'dids'].includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name ?? c.id}</option>
                ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRestoreTarget(null)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => restoreCredential(restoreTarget, restoreCollectionId)}
                disabled={restoring || !restoreCollectionId}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {restoring ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shareTarget && selected && (
        <ShareCredentialModal
          resourceName={shareTarget.name ?? shareTarget.id}
          resourceUrl={`${wasOrigin}${shareTarget.url ?? ''}`}
          onCheckPublic={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            return s.client.space(s.spaceId).collection(selected.id).resource(shareTarget.id).isPublic();
          }}
          onCreatePublicLink={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            // Only this resource becomes world-readable; the collection
            // listing and its other members stay private
            await s.client.space(s.spaceId).collection(selected.id).resource(shareTarget.id).setPublic();
            return `${wasOrigin}${shareTarget.url ?? ''}`;
          }}
          onUnshare={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            // Reverts the resource to capability-only access
            await s.client.space(s.spaceId).collection(selected.id).resource(shareTarget.id).clearPolicy();
          }}
          onLoadCredential={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            // The stored body (a presentation envelope or a bare credential),
            // for the fields LinkedIn's add-to-profile form is filled from
            const data = await s.client.space(s.spaceId).collection(selected.id).resource(shareTarget.id).get();
            if (data instanceof Blob) {
              try {
                return JSON.parse(await data.text());
              } catch {
                return null;
              }
            }
            return data;
          }}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
