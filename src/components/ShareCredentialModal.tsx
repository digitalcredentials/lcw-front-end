import { useEffect, useState } from 'react';

interface ShareCredentialModalProps {
  resourceName: string;
  // Absolute URL of the credential in the space, offered to the device share
  // sheet and returned as the public link
  resourceUrl: string;
  // Whether the credential is already world-readable
  onCheckPublic: () => Promise<boolean>;
  // Marks the credential world-readable and resolves to its public URL
  onCreatePublicLink: () => Promise<string>;
  // Removes public access, so the link stops resolving
  onUnshare: () => Promise<void>;
  onClose: () => void;
}

const STUB_OPTIONS = ['Add to LinkedIn', 'QR code'];

export default function ShareCredentialModal({
  resourceName, resourceUrl, onCheckPublic, onCreatePublicLink, onUnshare, onClose,
}: ShareCredentialModalProps) {
  const [notice, setNotice] = useState('');
  const [linkState, setLinkState] = useState<'checking' | 'private' | 'public'>('checking');
  const [publicLink, setPublicLink] = useState(resourceUrl);
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [copied, setCopied] = useState<'public' | 'verifier' | null>(null);

  // Opens VerifierPlus on the public credential URL; the vc parameter is
  // passed unencoded, matching how VerifierPlus reads it from the fragment
  const verifierLink = `https://verifierplus.org/#verify?vc=${publicLink}`;

  useEffect(() => {
    let cancelled = false;
    onCheckPublic()
      .then((isPublic) => {
        if (!cancelled) {
          setLinkState(isPublic ? 'public' : 'private');
        }
      })
      .catch(() => {
        // If the check fails, offer to create: setPublic is idempotent
        if (!cancelled) {
          setLinkState('private');
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createPublicLink() {
    setBusy(true);
    setLinkError('');
    setNotice('');
    try {
      setPublicLink(await onCreatePublicLink());
      setLinkState('public');
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not create the public link.');
    } finally {
      setBusy(false);
    }
  }

  async function unshare() {
    setBusy(true);
    setLinkError('');
    try {
      await onUnshare();
      setLinkState('private');
      setNotice('Public access removed. The link no longer works.');
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not remove public access.');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(which: 'public' | 'verifier') {
    try {
      await navigator.clipboard.writeText(which === 'public' ? publicLink : verifierLink);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard unavailable; the link is selectable in the input
    }
  }
  // The device share sheet (email, message, AirDrop, ...) exists only where
  // the Web Share API does
  const canDeviceShare = typeof navigator.share === 'function';

  async function deviceShare() {
    try {
      await navigator.share({ title: resourceName, url: resourceUrl });
    } catch {
      // the user dismissed the share sheet; nothing to do
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Share Credential"
        className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-800">Share Credential</h2>
          <button
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">{resourceName}</p>

        <div className="space-y-2">
          {linkState === 'checking' && (
            <p className="text-sm text-gray-400 border border-gray-200 rounded-lg px-4 py-2.5">
              Checking public access…
            </p>
          )}
          {linkState === 'private' && (
            <button
              onClick={createPublicLink}
              disabled={busy}
              className="w-full text-left bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              {busy ? 'Creating public link…' : 'Create Public Link'}
            </button>
          )}
          {linkState === 'public' && (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <label htmlFor="public-link" className="block text-xs font-medium text-gray-700">
                Public link to raw credential source code:
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  id="public-link"
                  aria-label="Public link"
                  value={publicLink}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50"
                />
                <button
                  onClick={() => copyLink('public')}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs rounded-md px-3 transition-colors"
                >
                  {copied === 'public' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <label htmlFor="verifierplus-link" className="block text-xs font-medium text-gray-700 pt-1">
                Public link to verified human readable version:
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  id="verifierplus-link"
                  aria-label="VerifierPlus link"
                  value={verifierLink}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50"
                />
                <button
                  onClick={() => copyLink('verifier')}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs rounded-md px-3 transition-colors"
                >
                  {copied === 'verifier' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                onClick={unshare}
                disabled={busy}
                className="w-full text-left border border-red-200 hover:bg-red-50 disabled:opacity-60 text-red-600 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                {busy ? 'Removing public access…' : 'Unshare'}
              </button>
              <p className="text-xs text-gray-500">
                Unsharing removes public access: the link will stop working for
                anyone who tries to use it.
              </p>
            </div>
          )}
          {linkError && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {linkError}
            </p>
          )}
          {STUB_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setNotice(`${option} is coming soon.`)}
              className="w-full text-left bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              {option}
            </button>
          ))}
          {canDeviceShare && (
            <button
              onClick={deviceShare}
              className="w-full text-left bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              Share via device…
            </button>
          )}
        </div>

        {notice && (
          <p role="status" className="mt-4 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
