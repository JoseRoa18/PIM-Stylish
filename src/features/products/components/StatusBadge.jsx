const STATUS_CONFIG = {
  new: {
    // Light red tint — uses the brand primary container
    bg: 'bg-primary-container',
    text: 'text-on-primary-container',
    label: 'New',
  },
  in_review: {
    // Brand beige — warm "in progress" feel
    bg: 'bg-tertiary-container',
    text: 'text-on-tertiary-container',
    label: 'In Review',
  },
  ready_to_sell: {
    bg: 'bg-success-container',
    text: 'text-on-success-container',
    label: 'Ready to Sell',
  },
  archived: {
    bg: 'bg-surface-container-high',
    text: 'text-on-surface-variant',
    label: 'Archived',
  },
};

export default function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] ?? {
    bg: 'bg-surface-container-high',
    text: 'text-on-surface-variant',
    label: status || '—',
  };

  return (
    <span
      className={`inline-block px-2 py-1 rounded-full text-label-md font-semibold whitespace-nowrap ${config.bg} ${config.text}`}
    >
      {config.label}
    </span>
  );
}