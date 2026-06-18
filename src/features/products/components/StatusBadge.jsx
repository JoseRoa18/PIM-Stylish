import { statusMeta } from '../lib/workflowStatus';

export default function StatusBadge({ status }) {
  const meta = statusMeta(status);

  return (
    <span
      className={`inline-block px-2 py-1 rounded-full text-label-md font-semibold whitespace-nowrap ${meta.badge}`}
    >
      {meta.label}
    </span>
  );
}
