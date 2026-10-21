import type { Failure } from '../lib/errors';

// A failure's plain sentence, with its technical text folded away behind a
// toggle for whoever is debugging (src/lib/errors.ts).
export default function FailureText({ failure }: { failure: Failure }) {
  return (
    <>
      {failure.text}
      {failure.detail && (
        <details className="mt-1 text-xs text-red-500">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <span className="block mt-1 break-words font-mono">{failure.detail}</span>
        </details>
      )}
    </>
  );
}
