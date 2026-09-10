import Dialog from '@/components/ui/Dialog';

/**
 * A marketplace with more than one kind of template asks which one to fill
 * before anything downloads: new listing, update, prices or promotions.
 */
export default function ExportPurposeDialog({ marketplace, purposes, onPick, onClose }) {
  return (
    <Dialog onClose={onClose} title={`Export ${marketplace}`} subtitle="Which file do you want to download?" maxWidth="max-w-md">
      <div className="grid gap-2">
        {purposes.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onPick(p.value)}
            className="group flex items-center gap-3 px-4 py-3 rounded-xl border border-outline-variant bg-surface text-left hover:border-primary/40 hover:bg-surface-container-low transition-colors"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body-md text-on-surface font-medium">{p.label}</span>
              <span className="block text-body-sm text-on-surface-variant">{p.hint}</span>
            </span>
            <span className="flex-shrink-0 text-label-sm text-on-surface-variant">{p.count} file{p.count === 1 ? '' : 's'}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
