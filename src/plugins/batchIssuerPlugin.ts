import BatchIssuer from './BatchIssuer';
import type { WalletPlugin } from './types';

export const batchIssuerPlugin: WalletPlugin = {
  id: 'batch-issuer',
  title: 'Credential Issuer',
  page: {
    path: '/batches',
    description: 'Issue batches of credentials from a CSV',
    Component: BatchIssuer,
  },
};
