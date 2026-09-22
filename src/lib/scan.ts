import QrScanner from 'qr-scanner';
import { fromQrCode } from '@digitalcredentials/vpqr';
import { securityLoader } from '@interop/security-document-loader';

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
      throw new Error(`The QR code points at ${text}, which could not be fetched.`);
    }
    if (!res.ok) {
      throw new Error(`The QR code points at ${text}, which answered ${res.status}.`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`The QR code points at ${text}, which did not return JSON.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The QR code does not contain a credential, a link to one, or JSON.');
  }
}

// Reads the QR code out of an image file (drag-and-drop or file picker)
export async function scanImageFile(file: File): Promise<string> {
  const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
  return result.data;
}

export { QrScanner };
