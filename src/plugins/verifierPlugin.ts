import VerifierDetail from './Verifier';
import type { WalletPlugin } from './types';

// Fills the verification panel of the credential detail view; no page of its
// own, so no route and no sidebar link.
export const verifierPlugin: WalletPlugin = {
  id: 'verifier',
  title: 'Verifier',
  slots: { credentialDetail: VerifierDetail },
};
