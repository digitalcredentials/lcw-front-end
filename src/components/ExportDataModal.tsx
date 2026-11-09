import { useState } from 'react';
import { exportWalletData, saveWalletExport } from '../lib/exportWallet';
import { describeError, type Failure } from '../lib/errors';
import FailureText from './FailureText';

// Settings → Download my data: says what the file holds and that it is not
// encrypted, then builds the export (src/lib/exportWallet.ts) and hands it
// to the browser's download. A document that could not be decrypted is
// listed after the download rather than stopping it.
export default function ExportDataModal({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ fileName: string; documents: number; problems: string[] } | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const result = await exportWalletData();
      saveWalletExport(result);
      const documents = result.manifest.spaces.reduce(
        (n, space) => n + space.collections.reduce((m, c) => m + c.documents, 0),
        0
      );
      setDone({ fileName: result.fileName, documents, problems: result.manifest.problems });
    } catch (err) {
      setError(describeError('export-data', err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
      <div role="dialog" aria-label="Download my data" className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-2">Download my data</h2>
        {done ? (
          <>
            <p className="text-sm text-gray-600 mb-4" data-testid="export-done">
              Your download, <span className="font-medium text-gray-800">{done.fileName}</span>, holds{' '}
              {done.documents === 1 ? '1 document' : `${done.documents} documents`}.
            </p>
            {done.problems.length > 0 && (
              <div role="alert" className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p className="font-medium mb-1">Some documents were left out:</p>
                <ul className="list-disc pl-5 space-y-1">
                  {done.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">
              This makes one file (a <span className="font-mono">.tar</span> archive) holding every
              document in every one of your spaces, with a folder for each space and a folder inside
              it for each collection. Your account records and keys are not included.
            </p>
            <div role="note" className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              The documents in the file are <span className="font-semibold">not encrypted</span>.
              Anyone who can open the file can read your credentials, so keep it somewhere private
              and delete it when you no longer need it.
            </div>
            {error && (
              <div role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <FailureText failure={error} />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void download()}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors"
              >
                {busy ? 'Preparing your download…' : 'Download'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
