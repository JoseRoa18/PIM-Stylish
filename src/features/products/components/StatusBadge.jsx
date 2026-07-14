import { statusMeta } from '../lib/workflowStatus';

export default function StatusBadge({ status }) {
  const meta = statusMeta(status);

  // "New" is the default state of most of the catalog — a quiet outline keeps
  // the column readable so the exceptional states (Audit, Re-Launch…) stand out.
  if (status === 'new') {
    return (
      <span className="inline-block px-2 py-1 rounded-full text-label-md whitespace-nowrap border border-outline-variant text-on-surface-variant">
        {meta.label}
      </span>
    );
  }

  return (
    <span
      className={`inline-block px-2 py-1 rounded-full text-label-md font-semibold whitespace-nowrap ${meta.badge}`}
    >
      {meta.label}
    </span>
  );
}
