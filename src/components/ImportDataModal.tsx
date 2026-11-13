import { useRef, useState } from 'react';
import { sessionStores } from '../lib/credentialStore';
import { NotAnExportError, importCredentials, readDataExport, type DataExportContents, type ImportResult } from '../lib/dataImport';
import { getEmail } from '../lib/auth';
import { describeError, type Failure } from '../lib/errors';
import FailureText from './FailureText';

// Settings → Import my data: takes a file Download my data made, says what
// it holds, and adds its credentials back to the account
// (src/lib/dataImport.ts). A credential already there is left as it is;
// documents that are not credentials are skipped and counted.
export default function ImportDataModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [contents, setContents] = useState<DataExportContents | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const account = getEmail();

  async function choose(file: File | undefined) {
    setContents(null);
    setReadError(null);
    setError(null);
    if (!file) {
      return;
    }
    setFileName(file.name);
    try {
      setContents(readDataExport(new Uint8Array(await file.arrayBuffer())));
    } catch (err) {
      setReadError(err instanceof NotAnExportError ? err.message : "That file couldn't be read.");
    }
  }

  async function run() {
    if (!contents) {
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const stores = await sessionStores();
      if (!stores) {
        throw new Error('UNAUTHORIZED');
      }
      setResult(await importCredentials({ credentials: contents.credentials, store: stores.store, onProgress: setProgress }));
    } catch (err) {
      setError(describeError('import-data', err));
      setProgress(null);
    }
  }

  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const exportedFrom = contents?.manifest.account;
  const exportedAt = contents ? new Date(contents.manifest.exportedAt) : null;
  const busy = progress !== null && result === null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
      <div role="dialog" aria-label="Import my data" className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-2">Import my data</h2>
        {result ? (
          <>
            <p className="text-sm text-gray-600 mb-4" data-testid="import-done">
              Added {count(result.added, 'credential')}.{' '}
              {result.existing > 0 && `${count(result.existing, 'credential')} ${result.existing === 1 ? 'was' : 'were'} already in your wallet.`}
            </p>
            {result.failed.length > 0 && (
              <div role="alert" className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p className="font-medium mb-1">Some credentials could not be added:</p>
                <ul className="list-disc pl-5 space-y-1">
                  {result.failed.map((failure) => (
                    <li key={failure.file}>
                      {failure.file}: {failure.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onDone}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">
              Choose a file you saved with <span className="font-medium text-gray-800">Download my data</span>. The
              credentials in it are added to your wallet; one that is already here is left as it is, and the tags the
              file gives it are added.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tar,application/x-tar"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void choose(file);
              }}
            />
            <div className="flex items-center gap-3 mb-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Choose file
              </button>
              {fileName && <span className="text-sm text-gray-600 truncate">{fileName}</span>}
            </div>
            {readError && (
              <div role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {readError}
              </div>
            )}
            {contents && (
              <div className="mb-4 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2" data-testid="import-summary">
                <p>
                  The file holds {count(contents.credentials.length, 'credential')}
                  {exportedAt && !Number.isNaN(exportedAt.getTime()) && `, saved ${exportedAt.toLocaleDateString()}`}
                  {exportedFrom && ` from ${exportedFrom}`}.
                </p>
                {exportedFrom && account && exportedFrom.toLowerCase() !== account.toLowerCase() && (
                  <p className="mt-1 text-amber-800">That is another account; the credentials will be added to this one.</p>
                )}
                {contents.skipped.length > 0 && (
                  <p className="mt-1 text-gray-500">
                    {count(contents.skipped.length, 'document')} in its credential folders {contents.skipped.length === 1 ? 'is' : 'are'} not a credential and will be skipped.
                  </p>
                )}
              </div>
            )}
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
                onClick={() => void run()}
                disabled={busy || !contents || contents.credentials.length === 0}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors"
              >
                {busy ? `Importing… ${progress} of ${contents?.credentials.length ?? 0}` : 'Import'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
