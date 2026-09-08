import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ResourceSummary, CollectionSummary } from '@interop/was-client';
import '@digitalcredentials/veri-good';
import type { VeriGoodElement } from '../types/veri-good';
import { getToken, clearToken } from '../lib/auth';
import { getSessionWASClient } from '../lib/was';

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
  const [error, setError] = useState('');
  // The clicked resource and its retrieved content, shown in the verifier modal
  const [viewing, setViewing] = useState<{ resource: ResourceSummary; vc: string } | null>(null);

  // <veri-good> fires veri-good-is-ready synchronously on connect, so by the
  // time React attaches the ref the element accepts verify() calls.
  const handleVerifierRef = useCallback(
    (node: HTMLElement | null) => {
      if (node && viewing) {
        (node as VeriGoodElement).verify(viewing.vc);
      }
    },
    [viewing]
  );

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

  // Retrieves the clicked resource through the WAS client (a signed request)
  // and hands its content to the verifier.
  const openResource = useCallback(async (resource: ResourceSummary) => {
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
      setViewing({ resource, vc });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session, selected]);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  function openCollection(collection: CollectionSummary) {
    setSelected(collection);
    setResources([]);
    loadResources(collection);
  }

  function backToCollections() {
    setSelected(null);
    setResources([]);
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
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm mb-4" aria-label="Breadcrumb">
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
                  <th className="px-4 py-3 text-right font-medium hidden md:table-cell">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {resources.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => openResource(item)}
                    className="hover:bg-gray-50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => { e.stopPropagation(); openResource(item); }}
                        className="flex items-center gap-2 text-left"
                      >
                        {FILE_ICON}
                        <span className="text-gray-700 hover:underline">{item.name ?? item.id}</span>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">
                      {item.contentType}
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
      </main>

      {/* Credential verifier: retrieved resource content is handed to <veri-good> */}
      {viewing && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setViewing(null)}
        >
          <div
            role="dialog"
            aria-label={viewing.resource.name ?? viewing.resource.id}
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800">
                {viewing.resource.name ?? viewing.resource.id}
              </h2>
              <button
                onClick={() => setViewing(null)}
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
            {/* No issuer-dids template: veri-good falls back to its default
                set of known issuer DIDs */}
            <veri-good ref={handleVerifierRef} />
          </div>
        </div>
      )}
    </div>
  );
}
