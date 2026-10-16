/**
 * The obsolete mark (user, 2026-10-16) — a mark of its own, apart from the
 * workflow status, which it never changes. The same pill as StatusBadge, in
 * the theme's inverse colors so it stands out without reading as an error.
 * Renders nothing for a product that is not obsolete. `compact` is the small
 * pill under a name (the catalog row).
 */
export default function ObsoleteBadge({ product, compact = false }) {
  if (!product?.is_obsolete) return null;
  return (
    <span
      className={`inline-block rounded-full font-semibold whitespace-nowrap bg-inverse-surface text-on-inverse-surface ${compact ? 'px-1.5 py-px text-label-sm' : 'px-2 py-1 text-label-md'}`}
    >
      Obsolete
    </span>
  );
}
