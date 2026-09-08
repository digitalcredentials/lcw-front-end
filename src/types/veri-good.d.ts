import type * as React from 'react';

// The package ships no type declarations; importing it registers the
// <veri-good> custom element.
declare module '@digitalcredentials/veri-good';

// The element's programmatic API (src/index.js in the veri-good repo).
export interface VeriGoodElement extends HTMLElement {
  verify(vc: string): void;
  setIssuerDids(list: string): void;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'veri-good': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
