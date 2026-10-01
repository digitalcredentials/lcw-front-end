import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import JSONInput from './JSONInput';
import { decodeQrPayload, scanImageFile, QrScanner } from '../lib/scan';

interface UploadCredentialModalProps {
  busy: boolean;
  error: string;
  onClose: () => void;
  // Called with the resource name and the credential JSON text
  onUpload: (name: string, text: string) => void;
}

export default function UploadCredentialModal({ busy, error, onClose, onUpload }: UploadCredentialModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  // One set of fields for all input modes: picking, dropping, or scanning
  // fills the name and the textarea, both still editable before confirming.
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');

  // The editor highlights errors as the user types; this gates the Add
  // button on the same condition.
  const jsonValid = useMemo(() => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);

  function stopCamera() {
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setScanning(false);
  }

  // The parent unmounts the modal on close; make sure the camera goes with it
  useEffect(() => stopCamera, []);

  async function stageQrText(qrText: string) {
    const credential = await decodeQrPayload(qrText);
    setName(`scanned-${Date.now()}.json`);
    setText(JSON.stringify(credential, null, 2));
  }

  async function stageFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setScanError('');
    try {
      if (file.type.startsWith('image/')) {
        await stageQrText(await scanImageFile(file));
      } else {
        setName(file.name);
        setText(await file.text());
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Could not read a credential from that file.');
    }
  }

  async function startCamera() {
    setScanError('');
    setScanning(true);
    try {
      // The video element renders once `scanning` is set; wait a tick for it
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!videoRef.current) {
        throw new Error('The camera view did not initialize.');
      }
      const scanner = new QrScanner(
        videoRef.current,
        async (result) => {
          stopCamera();
          try {
            await stageQrText(result.data);
          } catch (err) {
            setScanError(err instanceof Error ? err.message : 'Could not read a credential from that QR code.');
          }
        },
        { returnDetailedScanResult: true, highlightScanRegion: true }
      );
      scannerRef.current = scanner;
      await scanner.start();
    } catch (err) {
      stopCamera();
      setScanError(err instanceof Error ? err.message : 'Could not start the camera.');
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragActive(false);
    stageFile(e.dataTransfer.files?.[0]);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Add Credential"
        className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Add Credential</h2>
          <button
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>

        {/* Drop a file, or pick one; either fills the fields below */}
        <div
          data-testid="credential-drop-zone"
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl px-4 py-6 text-center cursor-pointer transition-colors ${
            dragActive ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <p className="text-sm text-gray-600 mb-3">
            Drag a credential file (.json) or a QR code image here
          </p>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            disabled={busy}
            className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
          >
            Choose File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json,image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              stageFile(file);
            }}
          />
        </div>

        {/* Scan a QR code with the camera: it can carry the credential itself
            (CBOR-LD) or a link to it */}
        <div className="mt-3">
          {!scanning ? (
            <button
              type="button"
              onClick={startCamera}
              disabled={busy}
              className="w-full bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
            >
              Scan QR code with camera
            </button>
          ) : (
            <div className="space-y-2">
              <video ref={videoRef} className="w-full rounded-xl border border-gray-200" />
              <button
                type="button"
                onClick={stopCamera}
                className="w-full border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-lg px-4 py-2 transition-colors"
              >
                Stop scanning
              </button>
            </div>
          )}
        </div>
        {scanError && (
          <p role="alert" className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {scanError}
          </p>
        )}

        <div className="flex items-center gap-3 my-4" aria-hidden="true">
          <div className="flex-1 border-t border-gray-200" />
          <span className="text-xs text-gray-400 uppercase tracking-wide">or paste JSON</span>
          <div className="flex-1 border-t border-gray-200" />
        </div>

        <div className="space-y-3">
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">
              Credential JSON
            </span>
            <JSONInput text={text} onChange={setText} />
          </div>
          <div>
            <label htmlFor="credential-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              id="credential-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-credential.json"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          <button
            onClick={() => onUpload(name.trim(), text)}
            disabled={busy || !text.trim() || !name.trim() || !jsonValid}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
