import type { ReactNode } from 'react';
import type { Failure } from '../lib/errors';

// A failure's plain sentence, then anything that belongs beside it (a Retry
// button), with the technical text folded away behind a toggle for whoever
// is debugging (src/lib/errors.ts).
export default function FailureText({ failure, children }: { failure: Failure; children?: ReactNode }) {
  return (
    <>
      {failure.text}
      {children}
      {failure.detail && (
        <details className="mt-1 text-xs text-red-500">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <span className="block mt-1 break-words font-mono">{failure.detail}</span>
        </details>
      )}
    </>
  );
}
