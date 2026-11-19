import Dialog from '@/components/ui/Dialog';

/**
 * Rona's new listing has two files — the DSCO catalog file and the Vendor
 * Quote Sheet (user, 2026-11-19): the export asks which one before anything
 * downloads. `choices` come from ronaListingChoices: each names the files it
 * would fill, so nobody has to guess which upload is behind a name.
 */
export default function RonaListingDialog({ choices, onPick, onClose }) {
  return (
    <Dialog onClose={onClose} title="Export Rona new listing" subtitle="Rona has two new listing files. Which one do you want to generate?" maxWidth="max-w-md">
      <div className="grid gap-2">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onPick(c.value)}
            className="group flex items-center gap-3 px-4 py-3 rounded-xl border border-outline-variant bg-surface text-left hover:border-primary/40 hover:bg-surface-container-low transition-colors"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body-md text-on-surface font-medium">{c.label}</span>
              <span className="block text-body-sm text-on-surface-variant">{c.hint}</span>
              <span className="block text-label-md text-on-surface-variant mt-1 [overflow-wrap:anywhere]">{c.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
