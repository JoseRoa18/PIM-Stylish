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
    // Green — universal success indicator (not in brand book but semantically necessary)
    bg: 'bg-emerald-100',
    text: 'text-emerald-800',
    label: 'Ready to Sell',
  },
  archived: {
    // Neutral gray
    bg: 'bg-gray-200',
    text: 'text-gray-700',
    label: 'Archived',
  },
};

export default function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] ?? {
    bg: 'bg-gray-200',
    text: 'text-gray-700',
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