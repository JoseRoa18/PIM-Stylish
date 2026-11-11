import { AlertTriangle } from 'lucide-react';

/**
 * The warnings of a promotion check (lib/promoChecks.js: marketWarnings /
 * dealWarnings) in the look of the form's other heads-ups: each line is
 * "N <what>: SKUs", and `note` says what the person can do. Nothing is drawn
 * without lines.
 */
export default function PromoCheckNotes({ lines, note = null }) {
  if (!lines?.length) return null;
  return (
    <div role="status" className="flex items-start gap-2.5 text-body-sm text-on-surface bg-error-container/35 rounded-lg px-3 py-2.5">
      <AlertTriangle className="w-4 h-4 mt-0.5 text-error flex-shrink-0" aria-hidden="true" />
      <div className="space-y-0.5 min-w-0 [overflow-wrap:anywhere]">
        {lines.map((l) => (
          <p key={`${l.title}${l.text ?? ''}`}>
            <span className="font-medium">{l.title}</span>{l.text ? ` ${l.text}` : ''}
          </p>
        ))}
        {note && <p className="text-on-surface-variant">{note}</p>}
      </div>
    </div>
  );
}
