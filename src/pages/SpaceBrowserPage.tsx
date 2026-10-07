import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ResourceSummary, CollectionSummary, ResourceData } from '@interop/was-client';
import '@digitalcredentials/veri-good';
import type { VeriGoodElement } from '../types/veri-good';
import { getToken, clearToken, getSpaceUrl, getSessionKey } from '../lib/auth';
import { getSessionWASClient, getSessionWASClientFor } from '../lib/was';
import { listSpaces, createSpace, type SpaceInfo } from '../lib/spaces';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import { ensureEncryptedCollection, collectionDisplay, isEncryptedCollection, writeResource } from '../lib/edv';
import UploadCredentialModal from '../components/UploadCredentialModal';
import ShareCredentialModal from '../components/ShareCredentialModal';
import JSONInput from '../components/JSONInput';
import { plugins, useWalletHost } from '../plugins';
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
  const location = useLocation();
  // The client signs with the key pair that authenticated at login, against
  // the space URL the login API returned.
  // The space whose collections are open; null shows the spaces card view
  const [activeSpace, setActiveSpace] = useState<SpaceInfo | null>(null);
  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null);
  // Space names and descriptions for the cards and the open-space views,
  // keyed by space URL, fetched in the background from each space's WAS
  // description document — the single home for a space's display data (the
  // registry carries no name)
  const [spaceDetails, setSpaceDetails] = useState<Record<string, { name?: string; description?: string }>>({});
  // A clicked batch space, held while the user chooses between the batch
  // view (the batch issuer, opened on that batch) and the standard space view
  const [batchPrompt, setBatchPrompt] = useState<SpaceInfo | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceDescription, setNewSpaceDescription] = useState('');
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [newSpaceError, setNewSpaceError] = useState('');

  const session = useMemo(
    () => (activeSpace ? getSessionWASClientFor(activeSpace.url) : getSessionWASClient()),
    [activeSpace]
  );
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
  const [moveTarget, setMoveTarget] = useState<ResourceSummary | null>(null);
  const [moveCollectionId, setMoveCollectionId] = useState('');
  const [moving, setMoving] = useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionDescription, setNewCollectionDescription] = useState('');
  // Collection display details (name + description) for the cards, keyed by
  // collection id, fetched in the background: from the encrypted /meta custom
  // for encrypted collections, from the plaintext description document
  // otherwise
  const [collectionDetails, setCollectionDetails] = useState<Record<string, { name?: string; description?: string }>>({});
  const [editDescriptionOpen, setEditDescriptionOpen] = useState(false);
  const [descriptionTarget, setDescriptionTarget] = useState<'collection' | 'space'>('collection');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  // The space name edited alongside the description (spaces only; collection
  // ids are path segments, so collections are not renamed here)
  const [nameDraft, setNameDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState('');
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
  // Plugin components for the verification panel (src/plugins/index.ts);
  // the registry is a module constant, so this list never changes at run time
  const detailSlots = plugins.flatMap((plugin) => plugin.slots?.credentialDetail ?? []);
  const host = useWalletHost();
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

      // Fetch each collection's display fields in the background for the
      // cards: /meta is the one home (decoded transparently when encrypted),
      // with the description document as the legacy fallback
      void Promise.all(
        items.map(async (item): Promise<[string, { name?: string; description?: string }] | null> => {
          try {
            const display = await collectionDisplay(s.client.space(s.spaceId).collection(item.id));
            return display ? [item.id, display] : null;
          } catch {
            return null;
          }
        })
      ).then((entries) => {
        const found = entries.filter((e): e is [string, { name?: string; description?: string }] => e !== null);
        if (found.length) {
          setCollectionDetails((current) => ({ ...current, ...Object.fromEntries(found) }));
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
      const space = s.client.space(s.spaceId);
      const source = space.collection(selected.id);
      if (selected.id !== 'Trash' && (await isEncryptedCollection(source))) {
        // The server's soft delete copies the raw envelope into Trash, which
        // Trash's own key epoch cannot read. Instead: re-encrypt the decrypted
        // body into Trash under Trash's epoch, delete the original, and purge
        // the server's envelope copy (a delete inside Trash is permanent).
        const data = await source.resource(resource.id).get();
        const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
        const storedKeyPair = getSessionKey();
        if (body !== null && storedKeyPair) {
          await ensureEncryptedCollection({ space, id: 'Trash', storedKeyPair, name: 'Trash' });
          await space.collection('Trash').add(body as ResourceData);
        }
        await source.resource(resource.id).delete();
        await space.collection('Trash').resource(resource.id).delete();
      } else {
        await source.resource(resource.id).delete();
      }
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
      await writeResource({
        collection: space.collection(targetCollectionId),
        name: resource.id,
        body: body as ResourceData,
      });
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

  // Moves a credential into another collection: copy the stored body over,
  // delete the original (the server soft-deletes it into Trash), then delete
  // the Trash copy (a DELETE inside Trash is permanent), so the move leaves
  // nothing behind.
  const moveCredential = useCallback(async (resource: ResourceSummary, targetCollectionId: string) => {
    if (!selected || !targetCollectionId) {
      return;
    }
    setMoving(true);
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
        throw new Error('The credential could not be read.');
      }
      const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
      await writeResource({
        collection: space.collection(targetCollectionId),
        name: resource.id,
        body: body as ResourceData,
      });
      await space.collection(selected.id).resource(resource.id).delete();
      await space.collection('Trash').resource(resource.id).delete();
      setMoveTarget(null);
      setViewing((v) => (v?.resource.id === resource.id ? null : v));
      await loadResources(selected);
    } catch (err) {
      setMoveTarget(null);
      handleError(err);
    } finally {
      setMoving(false);
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

  // The credential being viewed, with its presentation envelope removed;
  // null when the stored resource is not a credential (or not JSON).
  const viewingCredential = useMemo<CredentialLike | null>(() => {
    if (!viewing) {
      return null;
    }
    try {
      return credentialFrom(JSON.parse(viewing.vc));
    } catch {
      return null;
    }
  }, [viewing]);

  // The formatted summary shown at the top of the credential detail view
  const viewingSummary = useMemo(() => {
    const credential = viewingCredential;
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
  }, [viewingCredential]);


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
      await writeResource({
        collection: s.client.space(s.spaceId).collection(selected.id),
        name,
        body: credential as ResourceData,
      });
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
      // New credential collections are end-to-end encrypted, and their
      // display fields (name, description) live in the encrypted /meta
      // custom — nothing readable lands in the plaintext Description.
      const description = newCollectionDescription.trim();
      const collectionId = name.replace(/\s+/g, '-');
      const storedKeyPair = getSessionKey();
      if (!storedKeyPair) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      await ensureEncryptedCollection({
        space: s.client.space(s.spaceId),
        id: collectionId,
        storedKeyPair,
        name,
        ...(description && { description }),
      });
      setCollectionDetails((current) => ({
        ...current,
        [collectionId]: { name, ...(description && { description }) },
      }));
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

  // Writes the open collection's description: read the current description
  // document, merge the new text in, and PUT the whole document back (the WAS
  // update-or-create by id operation) — a raw request because the client's
  // configure() helper strips fields outside its writable set. Merging keeps
  // whatever else the document carries (e.g. the batch collections' special
  // flag).
  const saveDescription = useCallback(async () => {
    if (descriptionTarget === 'collection' ? !selected : !activeSpace) {
      return;
    }
    setSavingDescription(true);
    setDescriptionError('');
    try {
      const s = await session;
      if (!s) {
        clearToken();
        navigate('/login', { replace: true });
        return;
      }
      const description = descriptionDraft.trim();
      if (descriptionTarget === 'collection' && selected) {
        // One write path for every collection: /meta's custom, encrypted
        // transparently when the collection is. setMeta is a full
        // replacement, so the name rides along.
        const col = s.client.space(s.spaceId).collection(selected.id);
        const name = collectionDetails[selected.id]?.name ?? selected.name ?? selected.id;
        await col.setMeta({
          custom: { name, ...(description && { tags: { description } }) },
        });
        setCollectionDetails((current) => {
          const entry = { ...current[selected.id] };
          if (description) {
            entry.description = description;
          } else {
            delete entry.description;
          }
          return { ...current, [selected.id]: entry };
        });
      } else if (activeSpace) {
        // The space's description document (metadata/description.json),
        // written whole; the server stamps the derived fields. The edited
        // name is written too — the description document is the only home
        // for a space's name.
        const existing = (await s.client.space(s.spaceId).describe()) ?? {};
        const name = nameDraft.trim()
          || ((existing as { name?: unknown }).name as string | undefined)
          || spaceDetails[activeSpace.url]?.name
          || s.spaceId;
        const document = {
          ...existing,
          type: ['Space'],
          name,
        } as Record<string, unknown>;
        if (description) {
          document.description = description;
        } else {
          delete document.description;
        }
        await s.client.request({
          path: `/space/${s.spaceId}`,
          method: 'PUT',
          json: document,
        });
        setSpaceDetails((current) => {
          const entry = { ...current[activeSpace.url], name };
          if (description) {
            entry.description = description;
          } else {
            delete entry.description;
          }
          return { ...current, [activeSpace.url]: entry };
        });
      }
      setEditDescriptionOpen(false);
    } catch (err) {
      setDescriptionError(err instanceof Error ? err.message : 'Could not save the description.');
    } finally {
      setSavingDescription(false);
    }
  }, [navigate, session, selected, activeSpace, descriptionTarget, descriptionDraft, nameDraft, spaceDetails, collectionDetails]);

  // The spaces list: the account's registered spaces from the back end, with
  // each space's description fetched in the background from its WAS
  // description document
  const loadSpaces = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await listSpaces();
      setSpaces(list);
      void Promise.all(
        list.map(async (space): Promise<[string, { name?: string; description?: string }] | null> => {
          try {
            const s = await getSessionWASClientFor(space.url);
            const desc = (await (s ? s.client.space(s.spaceId).describe() : null)) as
              | { name?: unknown; description?: unknown }
              | null;
            if (!desc) {
              return null;
            }
            return [space.url, {
              ...(typeof desc.name === 'string' && desc.name.trim() && { name: desc.name }),
              ...(typeof desc.description === 'string' && desc.description.trim() && { description: desc.description }),
            }];
          } catch {
            return null;
          }
        })
      ).then((entries) => {
        const found = entries.filter((e): e is [string, { name?: string; description?: string }] => e !== null);
        if (found.length) {
          setSpaceDetails((current) => ({ ...current, ...Object.fromEntries(found) }));
        }
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  // Clicking My Spaces or the wallet title navigates to /files even when this
  // page is already mounted: that pushes a new history entry (a new location
  // key) without remounting, so each new key returns the view to the spaces
  // cards.
  useEffect(() => {
    setActiveSpace(null);
    setSelected(null);
    setViewing(null);
    setError('');
  }, [location.key]);

  // Opening a space loads its collections; leaving it clears them
  useEffect(() => {
    if (activeSpace) {
      loadCollections();
    } else {
      setCollections([]);
      setSelected(null);
      setViewing(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpace]);

  function openSpace(space: SpaceInfo) {
    setSelected(null);
    setViewing(null);
    setActiveSpace(space);
  }

  function backToSpaces() {
    setActiveSpace(null);
    setError('');
  }

  // Creates a credential space through the back end, then writes its
  // description document when a description was given
  const createNewSpace = useCallback(async () => {
    const name = newSpaceName.trim();
    if (!name) {
      return;
    }
    setCreatingSpace(true);
    setNewSpaceError('');
    try {
      const spaceUrl = await createSpace('credential', name);
      const description = newSpaceDescription.trim();
      if (description) {
        const s = await getSessionWASClientFor(spaceUrl);
        if (s) {
          await s.client.request({
            path: `/space/${s.spaceId}`,
            method: 'PUT',
            json: { type: ['Space'], name, description },
          });
        }
      }
      setSpaceDetails((current) => ({
        ...current,
        [spaceUrl]: { name, ...(description && { description }) },
      }));
      setNewSpaceOpen(false);
      setNewSpaceName('');
      setNewSpaceDescription('');
      await loadSpaces();
    } catch (err) {
      setNewSpaceError(err instanceof Error ? err.message : 'Could not create the space.');
    } finally {
      setCreatingSpace(false);
    }
  }, [newSpaceName, newSpaceDescription, loadSpaces]);

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
    } else if (activeSpace) {
      loadCollections();
    } else {
      loadSpaces();
    }
  }

  const isEmpty = activeSpace
    ? (selected ? resources.length === 0 : collections.length === 0)
    : (spaces ?? []).length === 0;

  return (
    <AppShell>
      <div>
        {/* Breadcrumb and collection actions */}
        <div className="flex items-center justify-between mb-4">
          <nav className="flex items-center gap-2 text-sm" aria-label="Breadcrumb">
            <button
              onClick={backToSpaces}
              disabled={!activeSpace}
              className="text-gray-500 hover:text-gray-700 disabled:text-gray-400 disabled:cursor-default transition-colors"
            >
              Spaces
            </button>
            {activeSpace && (
              <>
                <span className="text-gray-300" aria-hidden="true">/</span>
                <button
                  onClick={backToCollections}
                  disabled={!selected}
                  className={selected
                    ? 'text-gray-500 hover:text-gray-700 transition-colors'
                    : 'text-gray-800 font-medium cursor-default'}
                >
                  {spaceDetails[activeSpace.url]?.name ?? <LoadingLabel />}
                </button>
              </>
            )}
            {selected && (
              <>
                <span className="text-gray-300" aria-hidden="true">/</span>
                <span className="text-gray-800 font-medium">{collectionDetails[selected.id]?.name ?? selected.name ?? selected.id}</span>
              </>
            )}
          </nav>
          {selected ? (
            // Hidden while a credential's detail view is open; the detail
            // header carries that view's actions
            viewing?.mode !== 'detail' && (
              <button
                onClick={() => { setUploadError(''); setUploadOpen(true); }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Add Credential
              </button>
            )
          ) : activeSpace ? (
            <button
              onClick={() => { setNewCollectionError(''); setNewCollectionName(''); setNewCollectionOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              New Collection
            </button>
          ) : (
            <button
              onClick={() => { setNewSpaceError(''); setNewSpaceName(''); setNewSpaceDescription(''); setNewSpaceOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
            >
              New Space
            </button>
          )}
        </div>

        {/* The open space's description, with the same raised pencil edit as
            collections */}
        {activeSpace && !selected && (
          <div className="mb-4 -mt-1">
            <span className="text-base text-gray-600">
              {spaceDetails[activeSpace.url]?.description ?? ''}
            </span>
            <button
              onClick={() => {
                setNameDraft(spaceDetails[activeSpace.url]?.name ?? '');
                setDescriptionDraft(spaceDetails[activeSpace.url]?.description ?? '');
                setDescriptionError('');
                setDescriptionTarget('space');
                setEditDescriptionOpen(true);
              }}
              aria-label="Edit space name and description"
              title="Edit space name and description"
              className="relative -top-1.5 ml-1.5 inline-flex text-gray-400 hover:text-indigo-600 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793Z" />
                <path d="M11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
              </svg>
            </button>
          </div>
        )}

        {/* The open collection's description, with a pencil icon raised off
            the line to edit it (system collections excluded) */}
        {selected && viewing?.mode !== 'detail' && (
          <div className="mb-4 -mt-1">
            <span className="text-base text-gray-600">
              {collectionDetails[selected.id]?.description ?? ''}
            </span>
            {!['Trash', 'dids'].includes(selected.id) && (
              <button
                onClick={() => {
                  setDescriptionDraft(collectionDetails[selected.id]?.description ?? '');
                  setDescriptionError('');
                  setDescriptionTarget('collection');
                  setEditDescriptionOpen(true);
                }}
                aria-label={collectionDetails[selected.id]?.description ? 'Edit description' : 'Add description'}
                title={collectionDetails[selected.id]?.description ? 'Edit description' : 'Add description'}
                className="relative -top-1.5 ml-1.5 inline-flex text-gray-400 hover:text-indigo-600 transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                >
                  <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793Z" />
                  <path d="M11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* States */}
        {loading && (
          <div className="flex items-center justify-center py-20 text-sm">
            <LoadingLabel />
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
            {selected
              ? 'This collection is empty.'
              : activeSpace
                ? 'This space is empty.'
                : 'You have no spaces yet.'}
          </p>
        )}

        {/* Collections */}
        {/* The account's spaces, as cards */}
        {!loading && !error && !activeSpace && (spaces ?? []).length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(spaces ?? []).map((space) => (
              <button
                key={space.url}
                data-space-url={space.url}
                data-space-type={space.type}
                onClick={() => (space.type === 'batch' ? setBatchPrompt(space) : openSpace(space))}
                className="flex flex-col items-start gap-2 rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
              >
                <span className="flex w-full items-start justify-between gap-2">
                  {/* min-w-0 lets the name shrink inside the flex row, and
                      break-words wraps names (or URL fallbacks) with no
                      spaces, so neither the name nor the badge leaves the
                      card */}
                  <span className="min-w-0 break-words font-medium text-gray-800">
                    {spaceDetails[space.url]?.name ?? <LoadingLabel />}
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    space.type === 'batch' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'
                  }`}>
                    {/* The registry type 'credential' reads better plural */}
                    {space.type === 'credential' ? 'credentials' : space.type}
                  </span>
                </span>
                {spaceDetails[space.url]?.description && (
                  <span className="w-full break-words text-sm text-gray-500">
                    {spaceDetails[space.url].description}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* auto-rows-fr sizes every grid row to the tallest card, and the
            description is clamped to two lines, so cards with and without
            descriptions end up the same size */}
        {!loading && !error && activeSpace && !selected && collections.length > 0 && (
          <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((item) => (
              <button
                key={item.id}
                onClick={() => openCollection(item)}
                className="flex min-h-24 flex-col items-start gap-2 rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
              >
                <span className="flex items-center gap-2">
                  {FOLDER_ICON}
                  <span className="font-medium text-gray-800">{collectionDetails[item.id]?.name ?? item.name ?? item.id}</span>
                </span>
                {collectionDetails[item.id]?.description && (
                  <span className="line-clamp-2 text-sm text-gray-500">
                    {collectionDetails[item.id]?.description}
                  </span>
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
                      <>
                        <button
                          onClick={() => openResource(item, 'detail')}
                          className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          Open
                        </button>
                        <button
                          onClick={() => {
                            setMoveTarget(item);
                            setMoveCollectionId(
                              collections.find((c) => ![selected.id, 'Trash', 'dids', 'public'].includes(c.id))?.id ?? ''
                            );
                          }}
                          className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs font-medium rounded-md px-2.5 py-1.5 transition-colors"
                        >
                          Move
                        </button>
                      </>
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
                            collections.find((c) => !['Trash', 'dids', 'public'].includes(c.id))?.id ?? ''
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
            <div className="flex gap-2">
              <button
                onClick={() => setShareTarget(viewing.resource)}
                className="border border-gray-300 hover:bg-gray-100 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Share
              </button>
              <button
                onClick={() => {
                  setMoveTarget(viewing.resource);
                  setMoveCollectionId(
                    collections.find((c) => ![selected.id, 'Trash', 'dids', 'public'].includes(c.id))?.id ?? ''
                  );
                }}
                className="border border-gray-300 hover:bg-gray-100 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Move
              </button>
              <button
                onClick={() => setDeleteTarget(viewing.resource)}
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

        {/* The grid's default stretch plus flex columns make both panels the
            height of the taller one (the source editor fills its column) */}
        <div className={viewing?.mode === 'detail' ? 'grid gap-6 lg:grid-cols-2' : ''}>
          {selected && viewing?.mode === 'detail' ? (
            <section key="source" aria-label="Credential source" className="flex flex-col">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
                Credential Source
              </h2>
              <JSONInput text={viewingSource} readOnly className="flex-1 min-h-64" />
            </section>
          ) : (
            <span key="source" className="hidden" />
          )}
          <section
            key="verifier"
            className={selected && viewing?.mode === 'detail' ? 'flex flex-col' : 'hidden'}
            aria-label="Credential verification"
          >
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
              Credential Verification
            </h2>
            <div className="flex-1 bg-white rounded-xl border border-gray-200 p-6">
              {/* Plugins that fill the credentialDetail slot replace the
                  built-in veri-good element */}
              {detailSlots.length > 0
                ? detailSlots.map((Slot, index) => (
                    <Slot
                      key={index}
                      credential={viewingCredential as Record<string, unknown> | null}
                      host={host}
                    />
                  ))
                : <veri-good ref={handleVerifierRef} />}
            </div>
          </section>
        </div>

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
      </div>

      {uploadOpen && (
        <UploadCredentialModal
          busy={uploading}
          error={uploadError}
          onClose={() => setUploadOpen(false)}
          onUpload={uploadCredential}
        />
      )}

      {/* Edit the open collection's description, or the open space's name and
          description */}
      {editDescriptionOpen && (descriptionTarget === 'collection' ? selected : activeSpace) && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setEditDescriptionOpen(false)}
        >
          <div
            role="dialog"
            aria-label={descriptionTarget === 'collection' ? 'Collection Description' : 'Edit Space'}
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-4">
              {descriptionTarget === 'collection'
                ? `Description for ${(selected && collectionDetails[selected.id]?.name) ?? selected?.name ?? selected?.id}`
                : 'Edit Space'}
            </h2>
            <form
              onSubmit={(e) => { e.preventDefault(); saveDescription(); }}
              className="space-y-4"
            >
              {/* Spaces are renamed here; the name lives in the space's
                  description document, so the save writes both fields */}
              {descriptionTarget === 'space' && (
                <div>
                  <label htmlFor="edit-space-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Name
                  </label>
                  <input
                    id="edit-space-name"
                    type="text"
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder="e.g. Professional credentials"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                </div>
              )}
              <textarea
                autoFocus={descriptionTarget === 'collection'}
                rows={3}
                value={descriptionDraft}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                placeholder={descriptionTarget === 'collection' ? 'What this collection holds' : 'What this space holds'}
                aria-label={descriptionTarget === 'collection' ? 'Collection description' : 'Space description'}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              {descriptionError && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {descriptionError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditDescriptionOpen(false)}
                  className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDescription || (descriptionTarget === 'space' && !nameDraft.trim())}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {savingDescription ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* A batch space holds a credential batch, so ask whether to open it in
          the batch issuer (on that batch) or in the standard space view */}
      {batchPrompt && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setBatchPrompt(null)}
        >
          <div
            role="dialog"
            aria-label="Open Batch Space"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">
              Open {spaceDetails[batchPrompt.url]?.name ?? 'this space'}
            </h2>
            <p className="text-sm text-gray-600 mb-5">
              This space holds a credential batch. Open it in the batch view to
              edit the batch and notify recipients, or open the standard space
              view to browse its stored files.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBatchPrompt(null)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const space = batchPrompt;
                  setBatchPrompt(null);
                  openSpace(space);
                }}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Space View
              </button>
              <button
                onClick={() => navigate('/batches', { state: { spaceUrl: batchPrompt.url } })}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Batch View
              </button>
            </div>
          </div>
        </div>
      )}

      {newSpaceOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setNewSpaceOpen(false)}
        >
          <div
            role="dialog"
            aria-label="New Space"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-4">New Space</h2>
            <form
              onSubmit={(e) => { e.preventDefault(); createNewSpace(); }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="space-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  id="space-name"
                  type="text"
                  autoFocus
                  value={newSpaceName}
                  onChange={(e) => setNewSpaceName(e.target.value)}
                  placeholder="e.g. Professional credentials"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="space-description" className="block text-sm font-medium text-gray-700 mb-1">
                  Description <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <textarea
                  id="space-description"
                  rows={2}
                  value={newSpaceDescription}
                  onChange={(e) => setNewSpaceDescription(e.target.value)}
                  placeholder="What this space holds"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              {newSpaceError && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {newSpaceError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNewSpaceOpen(false)}
                  className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingSpace || !newSpaceName.trim()}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
                >
                  {creatingSpace ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                .filter((c) => !['Trash', 'dids', 'public'].includes(c.id))
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

      {/* Move to another collection: pick the destination */}
      {moveTarget && selected && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={() => setMoveTarget(null)}
        >
          <div
            role="dialog"
            aria-label="Move Credential"
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Move Credential</h2>
            {collections.some((c) => ![selected.id, 'Trash', 'dids', 'public'].includes(c.id)) ? (
              <>
                <p className="text-sm text-gray-600 mb-3">
                  Move <span className="font-medium text-gray-800">
                    {summaries[`${selected.id}/${moveTarget.id}`]?.title ?? moveTarget.name ?? moveTarget.id}
                  </span> into:
                </p>
                <label htmlFor="move-collection" className="sr-only">Collection to move into</label>
                <select
                  id="move-collection"
                  value={moveCollectionId}
                  onChange={(e) => setMoveCollectionId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-5"
                >
                  {collections
                    .filter((c) => ![selected.id, 'Trash', 'dids', 'public'].includes(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name ?? c.id}</option>
                    ))}
                </select>
              </>
            ) : (
              <p className="text-sm text-gray-600 mb-5">
                There is no other collection to move it into. Create one first.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setMoveTarget(null)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => moveCredential(moveTarget, moveCollectionId)}
                disabled={moving || !moveCollectionId}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {moving ? 'Moving…' : 'Move'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sharing publishes a plaintext copy in the space's dedicated public
          collection (a world-readable ciphertext would be useless), and
          unsharing deletes the copy. The copy's id names its origin. */}
      {shareTarget && selected && (
        <ShareCredentialModal
          resourceName={shareTarget.name ?? shareTarget.id}
          resourceUrl={`${activeSpace?.url ?? getSpaceUrl() ?? ''}/public/${selected.id}--${shareTarget.id}`}
          onCheckPublic={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            return s.client.space(s.spaceId)
              .collection('public', { encryption: 'plaintext' })
              .resource(`${selected.id}--${shareTarget.id}`)
              .isPublic();
          }}
          onCreatePublicLink={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            // The decrypted (or plaintext) body, copied into the public
            // collection; only that copy becomes world-readable, so the
            // source collection and its members stay private
            const publicId = `${selected.id}--${shareTarget.id}`;
            const data = await s.client.space(s.spaceId).collection(selected.id).resource(shareTarget.id).get();
            const body = data instanceof Blob ? JSON.parse(await data.text()) : data;
            const pub = s.client.space(s.spaceId).collection('public', { encryption: 'plaintext' });
            await pub.put(publicId, body as ResourceData);
            await pub.resource(publicId).setPublic();
            return `${activeSpace?.url ?? getSpaceUrl() ?? ''}/public/${publicId}`;
          }}
          onUnshare={async () => {
            const s = await session;
            if (!s) {
              throw new Error('Your session has expired. Sign in again.');
            }
            // Removes the public copy entirely: policy, the copy, and the
            // soft-delete remnant in Trash
            const publicId = `${selected.id}--${shareTarget.id}`;
            const pub = s.client.space(s.spaceId).collection('public', { encryption: 'plaintext' });
            await pub.resource(publicId).clearPolicy();
            await pub.resource(publicId).delete().catch(() => undefined);
            await s.client.space(s.spaceId).collection('Trash').resource(publicId).delete().catch(() => undefined);
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
    </AppShell>
  );
}
