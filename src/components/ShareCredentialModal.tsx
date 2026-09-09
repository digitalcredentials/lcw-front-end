import { useState } from 'react';

interface ShareCredentialModalProps {
  resourceName: string;
  // Absolute URL of the credential in the space, offered to the device share
  // sheet
  resourceUrl: string;
  onClose: () => void;
}

const STUB_OPTIONS = ['Create Public Link', 'Add to LinkedIn', 'QR code'];

export default function ShareCredentialModal({ resourceName, resourceUrl, onClose }: ShareCredentialModalProps) {
  const [notice, setNotice] = useState('');
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
