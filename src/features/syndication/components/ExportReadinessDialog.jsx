import { useState } from 'react';
import Dialog from '@/components/ui/Dialog';

const CHIP_CAP = 36;

function ColumnChips({ items, chipClass, render }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, CHIP_CAP);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c) => (
        <span key={c.label} className={`px-2 py-0.5 rounded-md text-label-sm ${chipClass}`}>
          {render(c)}
        </span>
      ))}
      {items.length > CHIP_CAP && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="px-2 py-0.5 rounded-md text-label-sm text-primary font-medium hover:underline"
        >
          +{items.length - CHIP_CAP} more
        </button>
      )}
    </div>
  );
}

/**
 * Post-export readiness report: per generated file, which template columns
 * the PIM filled completely, partially, or not at all — so nobody has to
 * open the XLSX to find out.
 */
export default function ExportReadinessDialog({ reports, onClose }) {
  return (
    <Dialog
      onClose={onClose}
      title="Export readiness"
      subtitle="Column fill per generated file. Empty isn't always a gap — some columns are business data meant to be completed by hand."
      maxWidth="max-w-2xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-md font-semibold enabled:hover:brightness-110 transition"
        >
          Got it
        </button>
      }
    >
      <div className="space-y-6">
        {reports.map((r) => {
          const empty = r.columns.filter((c) => c.filled === 0);
          const partial = r.columns.filter((c) => c.filled > 0 && c.filled < r.rows);
          const full = r.columns.length - empty.length - partial.length;
          return (
            <section key={r.file}>
              <h4 className="text-title-md text-on-surface mb-1 break-all">{r.file}</h4>
              <p className="text-body-sm text-on-surface-variant mb-3">
                {r.rows} row{r.rows === 1 ? '' : 's'} · {full} of {r.columns.length} columns fully
                filled{partial.length > 0 && `, ${partial.length} partial`}
                {empty.length > 0 && `, ${empty.length} empty`}
              </p>

              {partial.length > 0 && (
                <div className="mb-3">
                  <p className="text-label-md text-on-surface-variant mb-1.5">
                    Partially filled (some products missing the value)
                  </p>
                  <ColumnChips
                    items={partial}
                    chipClass="bg-warning-container/60 text-on-warning-container"
                    render={(c) => `${c.label} · ${c.filled}/${r.rows}`}
                  />
                </div>
              )}

              {empty.length > 0 && (
                <div>
                  <p className="text-label-md text-on-surface-variant mb-1.5">Empty columns</p>
                  <ColumnChips
                    items={empty}
                    chipClass="bg-surface-container-high text-on-surface-variant"
                    render={(c) => c.label}
                  />
                </div>
              )}

              {empty.length === 0 && partial.length === 0 && (
                <p className="text-body-sm text-on-surface">
                  Every headed column came out filled for all rows.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
