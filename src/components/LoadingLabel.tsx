// An inline "Loading…" with a small spinner, shown wherever text is still
// being fetched (e.g. a space name read from its description document) —
// explicit, instead of a bare ellipsis placeholder.
export default function LoadingLabel({ label = 'Loading…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-normal text-gray-400">
      <span
        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-transparent"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
