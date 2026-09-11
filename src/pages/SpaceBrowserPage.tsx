import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ResourceSummary, CollectionSummary, ResourceData } from '@interop/was-client';
import '@digitalcredentials/veri-good';
import type { VeriGoodElement } from '../types/veri-good';
import { getToken, clearToken, getSpaceUrl } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';
import UploadCredentialModal from '../components/UploadCredentialModal';
import ShareCredentialModal from '../components/ShareCredentialModal';
import JSONInput from '../components/JSONInput';

// Issuers whose credentials the verifier accepts, keyed by DID
const ISSUER_DIDS = {
  'did:key:z6MknNQD1WHLGGraFi6zcbGevuAgkVfdyCdtZnQTGWVVvR5Q': {
    issuerName: 'DCC Demo University',
    url: 'https://digitalcredentials.mit.edu/'
  },
  'did:key:z6MktL8XGbuYv5f7hwf6hVyJkJWynNtNhcsXFYe9NJzjKHkW': {
    issuerName: 'Digital Credentials Consortium',
    url: 'https://digitalcredentials.mit.edu/'
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
  const [spaceName, setSpaceName] = useState('');
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selected, setSelected] = useState<CollectionSummary | null>(null);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [error, setError] = useState('');
  // The resource being shown below the browser (in the verifier or the
  // source viewer, per mode); its row in the resource table is highlighted
  const [viewing, setViewing] = useState<{
    resource: ResourceSummary;
    vc: string;
    mode: 'verify' | 'source';
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResourceSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [shareTarget, setShareTarget] = useState<ResourceSummary | null>(null);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
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
      const space = s.client.space(s.spaceId);
      const [description, collectionList] = await Promise.all([
        space.describe(),
        space.collections(),
      ]);
      setSpaceName(description?.name ?? s.spaceId);
      setCollections(collectionList?.items ?? []);
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
      setResources(resourceList?.items ?? []);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session]);

  // Retrieves a resource through the WAS client (a signed request) and shows
  // it below the browser: in the verifier, or in the read-only source viewer.
  const openResource = useCallback(async (resource: ResourceSummary, mode: 'verify' | 'source') => {
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
      if (mode === 'verify') {
        verifierRef.current?.verify(vc);
        verifierRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      await s.client.space(s.spaceId).collection(name.replace(/\s+/g, '-')).configure({
        name,
        force: true
      });
      setNewCollectionOpen(false);
      setNewCollectionName('');
      await loadCollections();
    } catch (err) {
      setNewCollectionError(err instanceof Error ? err.message : 'Could not create the collection.');
    } finally {
      setCreatingCollection(false);
    }
  }, [navigate, session, newCollectionName, loadCollections]);

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

  function handleSignOut() {
    clearToken();
    navigate('/login', { replace: true });
  }

  const isEmpty = selected ? resources.length === 0 : collections.length === 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-semibold text-gray-800">{spaceName}</span>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Sign out
        </button>
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
              Upload Credential
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
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-right font-medium hidden md:table-cell">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {collections.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => openCollection(item)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => { e.stopPropagation(); openCollection(item); }}
                        className="flex items-center gap-2 text-left"
                      >
                        {FOLDER_ICON}
                        <span className="text-gray-700 hover:underline">{item.name ?? item.id}</span>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400 hidden md:table-cell">
                      {item.url}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Resources in the selected collection */}
        {!loading && !error && selected && resources.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Content Type</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {resources.map((item) => (
                  <tr
                    key={item.id}
                    className={viewing?.resource.id === item.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}
                  >
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        {FILE_ICON}
                        <span className="text-gray-700">{item.name ?? item.id}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                      {item.contentType}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openResource(item, 'verify')}
                          className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          Verify
                        </button>
                        <button
                          onClick={() => openResource(item, 'source')}
                          className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          View Source
                        </button>
                        <button
                          onClick={() => setShareTarget(item)}
                          className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          Share
                        </button>
                        <button
                          onClick={() => setDeleteTarget(item)}
                          className="border border-red-200 hover:bg-red-50 text-red-600 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Credential verifier: mounted once, below the browser. Clicking a
            resource hands its retrieved content to verify() and highlights
            the row above. Hidden with CSS rather than unmounted -- the
            component misbehaves when remounted -- and shown only on the
            collection page once a credential has been selected. */}
        <section
          className={`mt-8 ${selected && viewing?.mode === 'verify' ? '' : 'hidden'}`}
          aria-label="Credential verification"
        >
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
              Credential Verification
            </h2>
            {viewing && (
              <span className="text-sm text-gray-600">
                {viewing.resource.name ?? viewing.resource.id}
              </span>
            )}
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <veri-good ref={handleVerifierRef} />
          </div>
        </section>

        {/* Read-only source viewer, in the same spot as the verifier */}
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
            <p className="text-sm text-gray-600 mb-5">
              Move <span className="font-medium text-gray-800">{deleteTarget.name ?? deleteTarget.id}</span> to
              the Trash collection?
            </p>
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

      {shareTarget && selected && (
        <ShareCredentialModal
          resourceName={shareTarget.name ?? shareTarget.id}
          resourceUrl={`${wasOrigin}${shareTarget.url ?? ''}`}
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
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
