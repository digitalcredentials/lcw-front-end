import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getToken, clearToken } from '../lib/auth';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import FailureText from '../components/FailureText';
import { CredentialMissingError, describeError, isSessionEnded, type Failure, type WalletAction } from '../lib/errors';
import UploadCredentialModal from '../components/UploadCredentialModal';
import ShareCredentialModal from '../components/ShareCredentialModal';
import JSONInput from '../components/JSONInput';
import { plugins, useWalletHost } from '../plugins';
import { suggestTag } from '../lib/collectionName';
import { tagCounts } from '../lib/credentials';
import {
  discardTrashItem,
  listTrash,
  normalizeTags,
  restoreFromTrash,
  sessionStores,
  trashCredential,
  type CredentialBody,
  type SessionStores,
  type StoredCredential,
  type TrashItem,
} from '../lib/credentialStore';
import {
  credentialsFrom,
  credentialName,
  issuerName,
  credentialIssuance,
  credentialExpiration,
  credentialImage,
  issuerImage,
  type CredentialLike,
} from '../lib/linkedin';

// The wallet's front page: every credential of the account as a card,
// narrowed by the holder's own tags (src/lib/credentials.ts), with a
// detail view (summary, source, verification, tags, share, delete) and the
// Trash. Batch spaces are the Credential Issuer page's; nothing here reads
// them.

interface Summary {
  title: string;
  logo: string | null;
  issuer: string | null;
  issuerLogo: string | null;
  issued: Date | null;
  expires: Date | null;
}

function summaryOf(body: CredentialBody): Summary | null {
  const credential = body as CredentialLike;
  return {
    title: credentialName(credential),
    logo: credentialImage(credential),
    issuer: issuerName(credential),
    issuerLogo: issuerImage(credential),
    issued: credentialIssuance(credential),
    expires: credentialExpiration(credential),
  };
}

// Newest first, by issuance date; credentials without one keep the
// storage order after the rest
function byIssuance(a: { summary: Summary | null }, b: { summary: Summary | null }): number {
  const at = a.summary?.issued?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bt = b.summary?.issued?.getTime() ?? Number.NEGATIVE_INFINITY;
  return bt - at;
}

const UNTAGGED = Symbol('untagged');
type Filter = Set<string> | typeof UNTAGGED;

// A row of the list: a stored credential, or a Trash record of one
interface Card {
  id: string;
  body: CredentialBody;
  tags: string[];
  summary: Summary | null;
  trash?: TrashItem;
}

const FILE_ICON = (
  <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const LOADS = new Set<WalletAction>(['load-credentials']);

export default function WalletPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const host = useWalletHost();
  const detailSlots = useMemo(() => plugins.flatMap((p) => (p.slots?.credentialDetail ? [p.slots.credentialDetail] : [])), []);

  const [credentials, setCredentials] = useState<StoredCredential[] | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [view, setView] = useState<'credentials' | 'trash'>('credentials');
  const [filter, setFilter] = useState<Filter>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<(Failure & { action: WalletAction }) | null>(null);
  // The open credential: its card, and whether the detail or the read-only
  // source view shows (Trash opens into the source view)
  const [viewing, setViewing] = useState<{ card: Card; mode: 'detail' | 'source' } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Card | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<Card | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<Failure | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [savingTags, setSavingTags] = useState(false);

  // The stores for the session: the replica of a remembered session, or
  // the Space directly; opened once, and reloaded on what reaches them
  const session = useMemo(() => sessionStores(), []);

  const handleError = useCallback((action: WalletAction, err: unknown, setter?: (f: Failure) => void) => {
    if (isSessionEnded(err)) {
      clearToken();
      navigate('/login', { replace: true });
      return;
    }
    const failure = describeError(action, err);
    if (setter) {
      setter(failure);
    } else {
      setError({ ...failure, action });
    }
  }, [navigate]);

  // Everything the account holds: the credentials with their tags, and the
  // Trash records
  const load = useCallback(async () => {
    if (!getToken()) {
      navigate('/login', { replace: true });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const [stored, trashed] = await Promise.all([s.store.loadCredentials(), listTrash(s.space)]);
      setCredentials(stored);
      setTrash(trashed);
    } catch (err) {
      handleError('load-credentials', err);
    } finally {
      setLoading(false);
    }
  }, [navigate, handleError, session]);

  useEffect(() => {
    void load();
  }, [load]);

  // A change that reached the store from elsewhere (another wallet's write,
  // pulled into the replica) reloads the list
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    void session.then((s) => {
      if (s && !cancelled) {
        unsubscribe = s.store.subscribe(() => void load());
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session, load]);

  // Clicking My Credentials or the wallet title navigates here even when
  // this page is already mounted: that pushes a new history entry (a new
  // location key) without remounting, so each new key returns the view to
  // the whole list.
  const loadRef = useRef(load);
  loadRef.current = load;
  const firstKey = useRef(true);
  useEffect(() => {
    setViewing(null);
    setView('credentials');
    setFilter(new Set());
    setError(null);
    // A later arrival here (the link, the title, an import's Done) reads
    // the Space again too; the mount's own read is the load effect's
    if (firstKey.current) {
      firstKey.current = false;
    } else {
      void loadRef.current();
    }
  }, [location.key]);

  const cards = useMemo<Card[]>(
    () => (credentials ?? []).map((c) => ({ id: c.cid, body: c.body, tags: c.tags, summary: summaryOf(c.body) })).sort(byIssuance),
    [credentials]
  );
  const trashCards = useMemo<Card[]>(
    () => trash.map((t) => ({ id: t.id, body: t.body, tags: t.tags, summary: summaryOf(t.body), trash: t })).sort(byIssuance),
    [trash]
  );
  const counts = useMemo(() => tagCounts(cards), [cards]);
  const tags = useMemo(() => [...counts.keys()].sort((a, b) => a.localeCompare(b)), [counts]);
  const untaggedCount = useMemo(() => cards.filter((c) => c.tags.length === 0).length, [cards]);

  // The cards the filter leaves: every selected tag must be on the card
  const shown = useMemo(() => {
    if (view === 'trash') {
      return trashCards;
    }
    if (filter === UNTAGGED) {
      return cards.filter((c) => c.tags.length === 0);
    }
    if (filter.size === 0) {
      return cards;
    }
    return cards.filter((c) => [...filter].every((tag) => c.tags.includes(tag)));
  }, [view, cards, trashCards, filter]);

  function toggleTag(tag: string) {
    setViewing(null);
    setFilter((current) => {
      const next = new Set(current === UNTAGGED ? [] : current);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  const selectedTags = filter === UNTAGGED ? new Set<string>() : filter;

  // --- actions ---------------------------------------------------------------

  async function withSession<T>(action: WalletAction, run: (s: SessionStores) => Promise<T>, setter?: (f: Failure) => void): Promise<T | undefined> {
    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return undefined;
      }
      return await run(s);
    } catch (err) {
      handleError(action, err, setter);
      return undefined;
    }
  }

  // Adds pasted, picked or dropped credential JSON, tagged with the
  // category its type suggests; the tags are the holder's to change
  async function upload(name: string, text: string) {
    setUploading(true);
    setUploadError(null);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      setUploadError({ text: `We couldn't read ${name}. Check that it's a credential file.` });
      setUploading(false);
      return;
    }
    if (!body || typeof body !== 'object') {
      setUploadError({ text: `We couldn't read ${name}. Check that it's a credential file.` });
      setUploading(false);
      return;
    }
    // A presentation envelope is unwrapped: each credential in it is stored
    // on its own
    const credentials = credentialsFrom(body);
    if (credentials.length === 0) {
      setUploadError({ text: `We couldn't read ${name}. Check that it's a credential file.` });
      setUploading(false);
      return;
    }
    const done = await withSession('upload', async (s) => {
      for (const credential of credentials) {
        await s.store.addCredential({ body: credential as CredentialBody, tags: [suggestTag(credential as Record<string, unknown>)] });
      }
      return true;
    }, setUploadError);
    setUploading(false);
    if (done) {
      setUploadOpen(false);
    }
    // It may have gone through even on a failure: reload so the person can
    // see where things stand
    void load();
  }

  async function remove(card: Card) {
    setDeleting(true);
    setError(null);
    const done = await withSession('delete', async (s) => {
      if (card.trash) {
        await discardTrashItem(s.space, card.trash);
      } else {
        await trashCredential({ ...s, cid: card.id });
      }
      return true;
    });
    setDeleting(false);
    setDeleteTarget(null);
    if (done) {
      setViewing((v) => (v?.card.id === card.id ? null : v));
      await load();
    }
  }

  async function restore(card: Card) {
    if (!card.trash) {
      return;
    }
    setRestoring(card.id);
    setError(null);
    const done = await withSession('restore', async (s) => {
      await restoreFromTrash({ ...s, item: card.trash! });
      return true;
    });
    setRestoring(null);
    if (done) {
      setViewing((v) => (v?.card.id === card.id ? null : v));
      await load();
    }
  }

  // Replaces the open credential's tags, on the server and in the list
  async function saveTags(card: Card, next: Iterable<string>) {
    const normalized = normalizeTags(next);
    setSavingTags(true);
    setError(null);
    const done = await withSession('save-tags', async (s) => {
      await s.store.setTags(card.id, normalized);
      return true;
    });
    setSavingTags(false);
    if (done) {
      setCredentials((current) => (current ?? []).map((c) => (c.cid === card.id ? { ...c, tags: normalized } : c)));
      setViewing((v) => (v?.card.id === card.id ? { ...v, card: { ...v.card, tags: normalized } } : v));
    }
  }

  function openCard(card: Card, mode: 'detail' | 'source') {
    setTagDraft('');
    setViewing({ card, mode });
    if (mode === 'detail') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function retry() {
    if (error && !LOADS.has(error.action)) {
      setViewing(null);
    }
    void load();
  }

  // --- derived views of the open credential -------------------------------------

  const viewingSource = useMemo(() => (viewing ? JSON.stringify(viewing.card.body, null, 2) : ''), [viewing]);
  const viewingCredential = useMemo<CredentialLike | null>(() => (viewing ? (viewing.card.body as CredentialLike) : null), [viewing]);
  const viewingSummary = useMemo(() => {
    const credential = viewingCredential;
    if (!credential) {
      return null;
    }
    const subject = credential.credentialSubject as { name?: unknown; hasCredential?: unknown; achievement?: unknown } | undefined;
    const achievement = [subject?.hasCredential ?? subject?.achievement ?? []].flat()[0] as { description?: unknown } | undefined;
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
  }, [viewingCredential]);

  const detailOpen = viewing?.mode === 'detail';
  const titleOf = (card: Card) => card.summary?.title ?? card.id;
  const isEmpty = !loading && !error && credentials !== null && shown.length === 0;

  return (
    <AppShell>
      <div>
        {/* The heading and the one action, Add Credential (hidden while a
            credential's detail view is open; that view carries its own
            actions). On a phone (below md) the action goes under the heading. */}
        <div className="flex flex-col items-start gap-3 md:flex-row md:gap-0 md:items-center md:justify-between mb-4">
          <h1 className="text-lg font-semibold text-gray-800">
            {view === 'trash' ? 'Trash' : 'My Credentials'}
          </h1>
          {!detailOpen && view === 'credentials' && (
            <button
              onClick={() => { setUploadError(null); setUploadOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              Add Credential
            </button>
          )}
        </div>

        {/* The filter bar: one chip per tag in use, Untagged, and Trash */}
        {!detailOpen && credentials !== null && (tags.length > 0 || untaggedCount > 0 || trash.length > 0) && (
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by tag">
            {view === 'credentials' && (cards.length > 0 || trash.length > 0) && (
              <button
                onClick={() => { setViewing(null); setFilter(new Set()); }}
                aria-pressed={filter !== UNTAGGED && filter.size === 0}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  filter !== UNTAGGED && filter.size === 0 ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                All ({cards.length})
              </button>
            )}
            {view === 'credentials' && tags.map((tag) => (
              <button
                key={tag}
                data-tag={tag}
                onClick={() => toggleTag(tag)}
                aria-pressed={selectedTags.has(tag)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  selectedTags.has(tag) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {tag} ({counts.get(tag)})
              </button>
            ))}
            {view === 'credentials' && untaggedCount > 0 && (
              <button
                onClick={() => { setViewing(null); setFilter(UNTAGGED); }}
                aria-pressed={filter === UNTAGGED}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  filter === UNTAGGED ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Untagged ({untaggedCount})
              </button>
            )}
            {trash.length > 0 && (
              <button
                onClick={() => { setViewing(null); setView(view === 'trash' ? 'credentials' : 'trash'); }}
                aria-pressed={view === 'trash'}
                className={`ml-auto rounded-full border px-3 py-1 text-sm transition-colors ${
                  view === 'trash' ? 'border-gray-700 bg-gray-700 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Trash ({trash.length})
              </button>
            )}
          </div>
        )}

        {/* States */}
        {loading && credentials === null && (
          <div className="flex items-center justify-center py-20 text-sm">
            <LoadingLabel />
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <FailureText failure={error}>
              <button onClick={retry} className="ml-3 underline hover:no-underline">
                {LOADS.has(error.action) ? 'Retry' : 'Show the list'}
              </button>
            </FailureText>
          </div>
        )}

        {isEmpty && !detailOpen && (
          <p className="text-center text-gray-400 text-sm py-20">
            {view === 'trash'
              ? 'Trash is empty.'
              : cards.length === 0
                ? 'You have no credentials yet. Add one, or claim one from an issuer.'
                : 'No credential carries every selected tag.'}
          </p>
        )}

        {/* The cards. A card shows the credential's title, issuer and dates,
            and its tags; the Trash's cards offer source, restore and a
            permanent delete instead of opening. */}
        {!error && credentials !== null && shown.length > 0 && !detailOpen && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((card) => (
              <div
                key={card.id}
                data-credential-id={card.id}
                className={`flex flex-col gap-3 rounded-xl border p-4 ${
                  viewing?.card.id === card.id ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  {card.summary?.logo ? (
                    <img src={card.summary.logo} alt="" className="h-12 w-12 shrink-0 rounded object-contain" />
                  ) : (
                    <span className="mt-1 shrink-0">{FILE_ICON}</span>
                  )}
                  <span className="font-medium text-gray-800 break-words">{titleOf(card)}</span>
                </div>
                {card.summary?.issuer && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    {card.summary.issuerLogo && (
                      <img src={card.summary.issuerLogo} alt="" className="h-5 w-5 shrink-0 rounded object-contain" />
                    )}
                    {card.summary.issuer}
                  </div>
                )}
                {(card.summary?.issued || card.summary?.expires) && (
                  <p className="text-xs text-gray-500">
                    {card.summary.issued && <>Issued {card.summary.issued.toLocaleDateString()}</>}
                    {card.summary.issued && card.summary.expires && ' · '}
                    {card.summary.expires && <>Expires {card.summary.expires.toLocaleDateString()}</>}
                  </p>
                )}
                {card.tags.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
                    {card.tags.map((tag) => (
                      <li key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{tag}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto flex items-center gap-2 pt-1">
                  {!card.trash ? (
                    <button
                      onClick={() => openCard(card, 'detail')}
                      className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                    >
                      Open
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => openCard(card, 'source')}
                        className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        View Source
                      </button>
                      <button
                        onClick={() => restore(card)}
                        disabled={restoring === card.id}
                        className="border border-gray-300 hover:bg-gray-100 disabled:opacity-60 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        {restoring === card.id ? 'Restoring…' : 'Restore'}
                      </button>
                      <button
                        onClick={() => setDeleteTarget(card)}
                        className="border border-red-200 hover:bg-red-50 text-red-600 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Credential detail view: header and actions, the formatted
            summary, the tags, then source and verification side by side.
            The verification section is always rendered (keyed, with a
            placeholder occupying the sibling slot) and hidden with CSS
            outside detail mode, so the plugin components in it are never
            remounted. */}
        {viewing && detailOpen && (
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:gap-0 md:items-center md:justify-between">
            <h2 className="text-lg font-semibold text-gray-800 break-words">{titleOf(viewing.card)}</h2>
            <div className="grid grid-cols-3 gap-2 md:flex">
              <button
                onClick={() => setShareTarget(viewing.card)}
                className="border border-gray-300 hover:bg-gray-100 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Share
              </button>
              <button
                onClick={() => setDeleteTarget(viewing.card)}
                className="border border-red-200 hover:bg-red-50 text-red-600 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setViewing(null)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Back to list
              </button>
            </div>
          </div>
        )}

        {viewing && detailOpen && viewingSummary && (
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
                        <a href={viewingSummary.issuerUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:text-indigo-700 text-xs">
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

        {/* The open credential's tags: each removable, and a field to add
            one, offering the tags already in use */}
        {viewing && detailOpen && (
          <section className="mb-6 bg-white rounded-xl border border-gray-200 p-5" aria-label="Tags">
            <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-2">Tags</h2>
            <div className="flex flex-wrap items-center gap-2">
              {viewing.card.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-sm text-gray-700">
                  {tag}
                  <button
                    onClick={() => saveTags(viewing.card, viewing.card.tags.filter((t) => t !== tag))}
                    disabled={savingTags}
                    aria-label={`Remove tag ${tag}`}
                    title={`Remove tag ${tag}`}
                    className="rounded-full text-gray-400 hover:text-red-600 disabled:opacity-60"
                  >
                    ×
                  </button>
                </span>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const tag = tagDraft.trim();
                  if (tag) {
                    void saveTags(viewing.card, [...viewing.card.tags, tag]).then(() => setTagDraft(''));
                  }
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  list="wallet-tags"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  placeholder="Add a tag"
                  aria-label="Add a tag"
                  className="w-44 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
                <datalist id="wallet-tags">
                  {tags.filter((t) => !viewing.card.tags.includes(t)).map((t) => <option key={t} value={t} />)}
                </datalist>
                <button
                  type="submit"
                  disabled={savingTags || !tagDraft.trim()}
                  className="border border-gray-300 hover:bg-gray-100 disabled:opacity-60 text-gray-700 text-sm font-medium rounded-lg px-3 py-1.5 transition-colors"
                >
                  {savingTags ? 'Saving…' : 'Add'}
                </button>
              </form>
            </div>
          </section>
        )}

        {/* The grid's default stretch plus flex columns make both panels the
            height of the taller one (the source editor fills its column) */}
        <div className={detailOpen ? 'grid gap-6 lg:grid-cols-2' : ''}>
          {viewing && detailOpen ? (
            <section key="source" aria-label="Credential source" className="flex flex-col">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Credential Source</h2>
              <JSONInput text={viewingSource} readOnly className="flex-1 min-h-64" />
            </section>
          ) : (
            <span key="source" className="hidden" />
          )}
          <section key="verifier" className={detailOpen ? 'flex flex-col' : 'hidden'} aria-label="Credential verification">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Credential Verification</h2>
            <div className="flex-1 bg-white rounded-xl border border-gray-200 p-6">
              {detailSlots.length === 0 && <p className="text-sm text-gray-500">No verifier plugin is installed.</p>}
              {detailSlots.map((Slot, index) => (
                <Slot key={index} credential={viewingCredential as Record<string, unknown> | null} host={host} />
              ))}
            </div>
          </section>
        </div>

        {/* Read-only source viewer for a trashed credential, below the list */}
        {viewing && viewing.mode === 'source' && (
          <section className="mt-8" aria-label="Credential source">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Credential Source</h2>
              <span className="text-sm text-gray-600">{titleOf(viewing.card)}</span>
            </div>
            <JSONInput text={viewingSource} readOnly />
          </section>
        )}
      </div>

      {uploadOpen && (
        <UploadCredentialModal
          busy={uploading}
          error={uploadError && <FailureText failure={uploadError} />}
          onClose={() => setUploadOpen(false)}
          onUpload={upload}
        />
      )}

      {/* Confirm before moving a credential to Trash, or deleting it for good */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={() => setDeleteTarget(null)}>
          <div role="dialog" aria-label="Delete Credential" className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Delete Credential</h2>
            {deleteTarget.trash ? (
              <p className="text-sm text-gray-600 mb-5">
                Delete <span className="font-medium text-gray-800">{titleOf(deleteTarget)}</span> for good? This can't be undone.
              </p>
            ) : (
              <p className="text-sm text-gray-600 mb-5">
                Move <span className="font-medium text-gray-800">{titleOf(deleteTarget)}</span> to Trash? You can restore it from there.
                {' '}A shared credential stops being shared.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors">
                Cancel
              </button>
              <button onClick={() => remove(deleteTarget)} disabled={deleting} className="bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sharing publishes a plaintext copy in the public-credentials
          collection under the credential's own id, so sharing again brings
          the same link back (src/lib/credentialStore.ts) */}
      {shareTarget && (
        <ShareCredentialModal
          resourceName={titleOf(shareTarget)}
          onFindPublicLink={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            return (await s.store.findPublicCopy(shareTarget.id)) ? s.store.publicCopyUrl(shareTarget.id) : null;
          }}
          onCreatePublicLink={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            const body = await s.store.readCredential(shareTarget.id);
            if (!body) {
              throw new CredentialMissingError('The storage returned nothing for this credential.');
            }
            return s.store.createPublicCopy(shareTarget.id, body);
          }}
          onUnshare={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            await s.store.removePublicCopy(shareTarget.id);
          }}
          onLoadCredential={async () => shareTarget.body}
          onClose={() => setShareTarget(null)}
        />
      )}
    </AppShell>
  );
}
