import BatchIssuer from './BatchIssuer';
import type { WalletPlugin } from './types';

export const batchIssuerPlugin: WalletPlugin = {
  path: '/batches',
  title: 'Credential Issuer',
  description: 'Issue batches of credentials from a CSV',
  Component: BatchIssuer,
};
