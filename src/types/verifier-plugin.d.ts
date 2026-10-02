import type * as React from 'react';
import type { Registry, VerifierCredential } from '@digitalcredentials/verifier-plugin';

// Importing @digitalcredentials/verifier-plugin registers the
// <verifier-credential> custom element. The package ships its own types; this
// only tells JSX about the tag. `credential` and `registries` are properties,
// not attributes: React 19 sets them as properties on a custom element that
// defines them.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'verifier-credential': React.DetailedHTMLProps<React.HTMLAttributes<VerifierCredential>, VerifierCredential> & {
        credential?: Record<string, unknown>;
        registries?: Registry[];
      };
    }
  }
}
