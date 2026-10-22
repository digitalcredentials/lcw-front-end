import QrScanner from 'qr-scanner';
import { fromQrCode } from '@digitalcredentials/vpqr';
import { securityLoader } from '@interop/security-document-loader';
import { PlainError } from './errors';

const documentLoader = securityLoader().build();

// A QR code can carry a credential three ways: a CBOR-LD-encoded presentation
// (the VP1- format the LCW mobile wallet uses), a URL that serves the
// credential JSON, or the JSON itself.
export async function decodeQrPayload(text: string): Promise<object> {
  if (text.startsWith('VP1-')) {
    const { vp } = await fromQrCode({ text, documentLoader });
    return vp;
  }
  if (/^https?:\/\//i.test(text)) {
    let res: Response;
    try {
      res = await fetch(text);
    } catch {
      throw new PlainError("We couldn't download the credential this QR code links to. Check your connection and try again.", `Fetching ${text} failed.`);
    }
    if (!res.ok) {
      throw new PlainError("The link in this QR code didn't return a credential. Ask whoever gave it to you for a new one.", `${text} answered ${res.status}.`);
    }
    try {
      return await res.json();
    } catch {
      throw new PlainError("The link in this QR code didn't return a credential. Ask whoever gave it to you for a new one.", `${text} did not return JSON.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PlainError("This QR code doesn't contain a credential or a link to one.");
  }
}

// Reads the QR code out of an image file (drag-and-drop or file picker)
export async function scanImageFile(file: File): Promise<string> {
  const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
  return result.data;
}

export { QrScanner };
