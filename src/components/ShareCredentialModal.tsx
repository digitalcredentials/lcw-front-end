import { useState } from 'react';

interface ShareCredentialModalProps {
  resourceName: string;
  // Absolute URL of the credential in the space, offered to the device share
  // sheet and returned as the public link
  resourceUrl: string;
  // Marks the credential world-readable and resolves to its public URL
  onCreatePublicLink: () => Promise<string>;
  onClose: () => void;
}

const STUB_OPTIONS = ['Add to LinkedIn', 'QR code'];

export default function ShareCredentialModal({ resourceName, resourceUrl, onCreatePublicLink, onClose }: ShareCredentialModalProps) {
  const [notice, setNotice] = useState('');
  const [publicLink, setPublicLink] = useState('');
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [copied, setCopied] = useState(false);

  async function createPublicLink() {
    setCreatingLink(true);
    setLinkError('');
    try {
      setPublicLink(await onCreatePublicLink());
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not create the public link.');
    } finally {
      setCreatingLink(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
          {!publicLink ? (
            <button
              onClick={createPublicLink}
              disabled={creatingLink}
              className="w-full text-left bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              {creatingLink ? 'Creating public link…' : 'Create Public Link'}
            </button>
          ) : (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  readOnly
                  aria-label="Public link"
                  value={publicLink}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50"
                />
                <button
                  onClick={copyLink}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs rounded-md px-3 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Anyone with this link can view this credential.
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
