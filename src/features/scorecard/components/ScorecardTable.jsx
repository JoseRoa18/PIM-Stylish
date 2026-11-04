import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Pencil, X, Loader2, MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatValue, goalLabel, meetsGoal, parseInput, toInput } from '../lib/format';
import { SECTIONS, sectionOf } from '../lib/sections';
import { addWeeks, weekRange, weekStartLabel, weekTag } from '../lib/weeks';

// One market of a board as the EOS grid (user's layout choice, 2026-11-04):
// rows grouped by theme, one line each — the owner's initials, the
// measurable, its goal — then the 13 weeks. A week's cell is green when it
// meets the goal and red when it misses it (with a check / cross, never
// color alone); its owner or an admin edits it in place. The 13 weeks fit
// the page from 1440 px; narrower, the table scrolls inside itself and
// opens on the latest week.
export default function ScorecardTable({ board, metrics, values, weeks, thisWeek, canWrite, isAdmin, onSave, onEditMetric }) {
  const groups = SECTIONS.map((s) => ({ ...s, rows: metrics.filter((m) => sectionOf(m) === s.key) })).filter((g) => g.rows.length);
  const scroller = useRef(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks, board.key]);
  const cols = 2 + weeks.length;
  return (
    // `relative`: the cells' sr-only texts are placed inside this scroll box
    // instead of widening the page.
    <div ref={scroller} className="relative overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container-lowest">
      <table className="min-w-full border-separate border-spacing-0 text-body-sm">
        <caption className="sr-only">{board.label} scorecard, weeks {weekTag(weeks[0])} to {weekTag(weeks.at(-1))}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-20 bg-surface-container-low text-left px-4 py-2.5 text-label-md text-on-surface-variant border-b border-outline-variant w-[17rem] min-w-[17rem] max-w-[17rem]">Measurable</th>
            <th scope="col" className="bg-surface-container-low text-right px-3 py-2.5 text-label-md text-on-surface-variant border-b border-outline-variant whitespace-nowrap">Goal</th>
            {/* A column holds the numbers of the week before it (W44 = Oct 25 – 31), so its dates are that week's. */}
            {weeks.map((w) => (
              <th key={w} scope="col" title={`Numbers of ${weekRange(addWeeks(w, -1))}`} className={cn('px-2 py-2 text-right border-b border-outline-variant whitespace-nowrap min-w-[4rem]', w === thisWeek ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-low text-on-surface-variant')}>
                <span className="block text-label-md">{weekTag(w)}</span>
                <span className="block text-label-sm font-normal">
                  <span aria-hidden>{weekStartLabel(addWeeks(w, -1))}</span>
                  <span className="sr-only">, numbers of {weekRange(addWeeks(w, -1))}{w === thisWeek ? ', this week' : ''}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            <tr>
              <th scope="colgroup" colSpan={cols} className="bg-surface-container text-left pt-3 pb-1.5 text-label-md uppercase tracking-wider text-on-surface-variant border-b border-outline-variant">
                {/* the label, not the full-width cell, stays pinned while the weeks scroll */}
                <span className="sticky left-0 inline-block px-4">{g.label}</span>
              </th>
            </tr>
            {g.rows.map((m) => (
              <tr key={m.id} className="group">
                <th scope="row" className="sticky left-0 z-10 bg-surface-container-lowest group-hover:bg-surface-container-low text-left font-normal pl-3 pr-2 py-1.5 border-b border-outline-variant w-[17rem] min-w-[17rem] max-w-[17rem]">
                  <div className="flex items-center gap-2 min-w-0">
                    <OwnerBadge label={m.owner_label} />
                    <span className="min-w-0 flex-1 truncate text-body-md text-on-surface" title={[m.name, m.owner_label && `Owner: ${m.owner_label}`, m.auto_key ? 'Filled by the PIM' : m.source && `Source: ${m.source}`].filter(Boolean).join('\n')}>
                      {m.name}
                    </span>
                    {m.auto_key && (
                      <span className="flex-shrink-0 px-1.5 rounded text-label-sm bg-secondary-container text-on-secondary-container" title="Filled by the PIM">
                        PIM<span className="sr-only">: filled by the PIM</span>
                      </span>
                    )}
                    {!m.auto_key && m.source && <span className="sr-only">Source: {m.source}</span>}
                    {isAdmin && (
                      <button type="button" onClick={() => onEditMetric(m)} aria-label={`Edit ${m.name}`} title="Edit measurable" className="relative flex-shrink-0 p-1 rounded-full text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-high transition-colors after:absolute after:-inset-1.5">
                        <Pencil className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                </th>
                <td className="px-3 py-1.5 border-b border-outline-variant text-right text-on-surface-variant whitespace-nowrap tabular-nums">{goalLabel(m) || <><span aria-hidden>—</span><span className="sr-only">No goal</span></>}</td>
                {weeks.map((w) => (
                  <ValueCell
                    key={w}
                    metric={m}
                    week={w}
                    row={values.get(`${m.id}|${w}`)}
                    current={w === thisWeek}
                    editable={canWrite(m)}
                    onSave={onSave}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function initials(label) {
  const parts = label.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : parts[0].slice(0, 2)).toUpperCase();
}

/** The owner as initials; the full name is the tooltip and what a screen reader hears. */
function OwnerBadge({ label }) {
  if (!label) {
    return (
      <span title="No owner" className="flex-shrink-0 w-6 h-6 rounded-full border border-dashed border-outline text-on-surface-variant text-label-sm flex items-center justify-center">
        <span aria-hidden>–</span>
        <span className="sr-only">No owner.</span>
      </span>
    );
  }
  return (
    <span title={label} className="flex-shrink-0 w-6 h-6 rounded-full bg-secondary-container text-on-secondary-container text-label-sm font-semibold flex items-center justify-center">
      <span aria-hidden>{initials(label)}</span>
      <span className="sr-only">Owner {label}.</span>
    </span>
  );
}

function ValueCell({ metric, week, row, current, editable, onSave }) {
  const [draft, setDraft] = useState(null); // text while editing
  const [saving, setSaving] = useState(false);
  const shown = formatValue(metric.unit, row);
  const ok = meetsGoal(metric, row?.value);
  const tone = ok === true ? 'bg-success-container text-on-success-container' : ok === false ? 'bg-error-container text-on-error-container' : current ? 'bg-primary-container/25' : '';
  const isText = metric.unit === 'text' || (row?.value == null && row?.note);
  const longNote = isText && shown.length > 7;
  const label = `${metric.name}, ${weekTag(week)} (numbers of ${weekRange(addWeeks(week, -1))})`;

  async function commit() {
    const text = draft;
    setDraft(null);
    if (text == null || text.trim() === toInput(metric.unit, row).trim()) return;
    setSaving(true);
    try {
      await onSave(metric, week, parseInput(metric.unit, text));
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <>
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" aria-label="Saving" /> : (
        <span className={cn('flex items-center justify-end gap-1', isText && 'justify-start')}>
          {/* a number the PIM filled carries a dot; the row says PIM */}
          {row?.origin === 'auto' && <span className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0" aria-hidden />}
          {ok === true && <Check className="w-3 h-3 flex-shrink-0" aria-hidden />}
          {ok === false && <X className="w-3 h-3 flex-shrink-0" aria-hidden />}
          {/* a long note shows as an icon so the 13 weeks keep fitting; its text is the tooltip and the sr-only line */}
          {longNote ? (
            <>
              <MessageSquareText className="w-4 h-4 flex-shrink-0 text-on-surface-variant" aria-hidden />
              <span className="sr-only">{shown}</span>
            </>
          ) : (
            <span className={cn(isText ? 'text-left whitespace-nowrap' : 'tabular-nums')}>{shown}</span>
          )}
        </span>
      )}
      {ok != null && <span className="sr-only">{ok ? ' — meets the goal' : ' — misses the goal'}</span>}
      {row?.origin === 'auto' && <span className="sr-only"> — filled by the PIM</span>}
    </>
  );
  const title = [row?.note && row?.value != null ? row.note : isText ? shown : null, row?.origin === 'auto' ? 'Filled by the PIM' : null].filter(Boolean).join(' · ') || undefined;

  if (draft != null) {
    return (
      <td className={cn('border-b border-outline-variant p-1', tone)}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
          }}
          aria-label={`${label}${metric.unit === 'percent' ? ', in percent' : ''}`}
          className={cn('w-full min-w-[5rem] px-2 py-1 rounded-md border border-primary bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30', isText ? 'text-left' : 'text-right tabular-nums')}
        />
      </td>
    );
  }
  return (
    <td className={cn('border-b border-outline-variant', tone)} title={title}>
      {editable ? (
        <button
          type="button"
          onClick={() => setDraft(toInput(metric.unit, row))}
          aria-label={`${label}: ${shown || 'empty'}. Edit`}
          className="w-full min-h-[2.25rem] px-2 py-1.5 text-right hover:bg-on-surface/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
        >
          {content}
        </button>
      ) : (
        <div className="px-2 py-1.5 text-right min-h-[2.25rem] flex items-center justify-end">{content}</div>
      )}
    </td>
  );
}
