import { useEffect, useLayoutEffect, useRef, useState, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Pencil, X, Loader2, MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/cn';
import Dialog from '@/components/ui/Dialog';
import { formatValue, goalLabel, meetsGoal, parseInput, toInput } from '../lib/format';
import { SECTIONS, sectionOf } from '../lib/sections';
import { addWeeks, weekDays, weekRange, weekSoFar, weekStartLabel, weekTag } from '../lib/weeks';

// One market of a board as the EOS grid (user's layout choice, 2026-11-04):
// rows grouped by theme, one line each — the owner's initials, the
// measurable, its goal — then the 13 weeks. A week's cell is green when it
// meets the goal and red when it misses it (with a check / cross, never
// color alone); its owner or an admin edits it in place. The 13 weeks fit
// the page from 1440 px; narrower, the table scrolls inside itself and
// opens on the latest week.
export default function ScorecardTable({ board, metrics, values, weeks, thisWeek, canWrite, isAdmin, onSave, onEditMetric }) {
  const groups = SECTIONS.map((s) => ({ ...s, rows: metrics.filter((m) => sectionOf(m) === s.key) })).filter((g) => g.rows.length);
  // The column of the week in progress: the numbers so far (user, 2026-11-06).
  const runningWeek = addWeeks(thisWeek, 1);
  const scroller = useRef(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Open on the week in progress, this week's column just before it (the coming ones, empty, sit after).
    const cur = el.querySelector('thead th[data-running]') ?? el.querySelector('thead th[data-current]');
    el.scrollLeft = cur ? Math.max(0, cur.offsetLeft + cur.offsetWidth - el.clientWidth) : el.scrollWidth;
  }, [weeks, board.key]);
  // The week header stays pinned while the page scrolls, under the page's
  // pinned controls (--sc-toolbar-h; user, 2026-11-05). When the 13 weeks fit,
  // the box only clips (no scroll box of its own) and the header itself is
  // sticky. When they do not (under ~1,650 px wide), the box scrolls sideways
  // — which stops a sticky header — so a copy of the header (aria-hidden,
  // the real one stays for screen readers) is pinned over it instead, with
  // the real columns' widths and the box's sideways scroll.
  const head = useRef(null);
  const copy = useRef(null);
  const [fits, setFits] = useState(false);
  const [layout, setLayout] = useState(null); // { widths, height, width } of the real header
  useLayoutEffect(() => {
    const el = scroller.current;
    const table = el?.querySelector('table');
    if (!el || !table) return undefined;
    const ro = new ResizeObserver(() => {
      setFits(table.offsetWidth <= el.clientWidth + 1);
      const ths = [...head.current.querySelectorAll('th')];
      setLayout({ widths: ths.map((th) => th.getBoundingClientRect().width), height: head.current.getBoundingClientRect().height, width: table.getBoundingClientRect().width });
    });
    ro.observe(el);
    ro.observe(table);
    return () => ro.disconnect();
  }, [weeks, board.key]);
  useLayoutEffect(() => {
    if (copy.current && scroller.current) copy.current.scrollLeft = scroller.current.scrollLeft;
  }, [layout, fits]);
  // Hovering a week's header shows the days its numbers cover (user,
  // 2026-11-06), at once — a native title waits a second. Drawn in <body>,
  // fixed under the header: the header boxes clip anything below them.
  const [tip, setTip] = useState(null); // { week, x, y }
  const showTip = (week, el) => {
    if (!week) { setTip(null); return; }
    const r = el.getBoundingClientRect();
    setTip({ week, x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150), y: r.bottom + 6 });
  };
  // Any scroll (the page, the table sideways) moves the header from under it.
  useEffect(() => {
    if (!tip) return undefined;
    const hide = () => setTip(null);
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, [tip]);
  const cols = 2 + weeks.length;
  const pinned = !fits && layout;
  const nameCol = 'w-[17rem] min-w-[17rem] max-w-[17rem]';

  return (
    <div>
      {pinned && (
        <div ref={copy} aria-hidden className="sticky top-[var(--sc-toolbar-h,0px)] z-20 overflow-hidden rounded-t-2xl border-x border-t border-outline-variant" style={{ marginBottom: -(layout.height + 1) }}>
          <table className="border-separate border-spacing-0 text-body-sm" style={{ width: layout.width, tableLayout: 'fixed' }}>
            <colgroup>{layout.widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><HeaderRow weeks={weeks} thisWeek={thisWeek} mode="copy" height={layout.height} nameCol={nameCol} onTip={showTip} /></thead>
          </table>
        </div>
      )}
      {/* `relative`: the cells' sr-only texts are placed inside this box instead of widening the page. */}
      <div
        ref={scroller}
        onScroll={(e) => { if (copy.current) copy.current.scrollLeft = e.currentTarget.scrollLeft; }}
        className={cn('relative rounded-2xl border border-outline-variant bg-surface-container-lowest', fits ? 'overflow-clip' : 'overflow-x-auto')}
      >
      <table className="min-w-full border-separate border-spacing-0 text-body-sm">
        <caption className="sr-only">{board.label} scorecard, weeks {weekTag(weeks[0])} to {weekTag(weeks.at(-1))}</caption>
        <thead ref={head}>
          <HeaderRow weeks={weeks} thisWeek={thisWeek} mode={fits ? 'sticky' : 'static'} nameCol={nameCol} onTip={showTip} />
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
                <th scope="row" className={`sticky left-0 z-10 bg-surface-container-lowest group-hover:bg-surface-container-low text-left font-normal pl-3 pr-2 py-1.5 border-b border-outline-variant ${nameCol}`}>
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
                    running={w === runningWeek}
                    editable={canWrite(m) && w <= thisWeek}
                    onSave={onSave}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      </div>
      {tip && createPortal(
        <div aria-hidden className="fixed z-50 -translate-x-1/2 pointer-events-none rounded-lg bg-inverse-surface text-on-inverse-surface px-3 py-2 shadow-lg whitespace-nowrap text-center" style={{ left: tip.x, top: tip.y }}>
          <div className="text-label-md font-semibold">{weekTag(tip.week)} · numbers of</div>
          <div className="text-body-sm">{weekDays(addWeeks(tip.week, -1))}</div>
          {tip.week > thisWeek && <div className="text-label-sm opacity-80">{tip.week === runningWeek ? 'In progress — numbers so far, updated every 3 hours' : 'Upcoming'}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * The header row. `mode`: 'sticky' = the real header pins itself (the table
 * fits); 'static' = the real header under its pinned copy; 'copy' = that copy.
 * The measurable's column stays pinned at the left in every mode.
 */
function HeaderRow({ weeks, thisWeek, mode, height, nameCol, onTip }) {
  const top = mode === 'sticky' ? 'sticky top-[var(--sc-toolbar-h,0px)]' : '';
  return (
    <tr style={height ? { height } : undefined}>
      <th scope="col" className={cn(top, 'sticky left-0', mode === 'sticky' ? 'z-[25]' : 'z-10', 'bg-surface-container-low text-left px-4 py-2.5 text-label-md text-on-surface-variant border-b border-outline-variant', nameCol)}>Measurable</th>
      <th scope="col" className={cn(top, mode === 'sticky' && 'z-20', 'bg-surface-container-low text-right px-3 py-2.5 text-label-md text-on-surface-variant border-b border-outline-variant whitespace-nowrap')}>Goal</th>
      {/* A column holds the numbers of the week before it (W44 = Oct 25 – 31), so its dates are that week's. */}
      {weeks.map((w) => (
        <th key={w} scope="col" data-current={w === thisWeek ? '' : undefined} data-running={w === addWeeks(thisWeek, 1) ? '' : undefined} onMouseEnter={(e) => onTip?.(w, e.currentTarget)} onMouseLeave={() => onTip?.(null)} className={cn(top, mode === 'sticky' && 'z-20', 'px-2 py-2 text-right border-b border-outline-variant whitespace-nowrap min-w-[4rem]', w === thisWeek ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-low text-on-surface-variant')}>
          <span className="block text-label-md">{weekTag(w)}</span>
          <span className="block text-label-sm font-normal">
            <span aria-hidden>{weekStartLabel(addWeeks(w, -1))}</span>
            {mode !== 'copy' && <span className="sr-only">, numbers of {weekDays(addWeeks(w, -1))}{w === thisWeek ? ', this week' : w > thisWeek ? ', upcoming' : ''}</span>}
          </span>
        </th>
      ))}
    </tr>
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

function ValueCell({ metric, week, row, current, running, editable, onSave }) {
  const [draft, setDraft] = useState(null); // text while editing
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false); // a long note open in full
  const shown = formatValue(metric.unit, row);
  // A week in progress is never judged against the goal: sales at mid-week would always miss it.
  const ok = running ? null : meetsGoal(metric, row?.value);
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
            <span className={cn(isText ? 'text-left whitespace-nowrap' : 'tabular-nums', running && 'italic text-on-surface-variant')}>{shown}</span>
          )}
        </span>
      )}
      {ok != null && <span className="sr-only">{ok ? ' — meets the goal' : ' — misses the goal'}</span>}
      {row?.origin === 'auto' && <span className="sr-only"> — filled by the PIM</span>}
      {running && row && <span className="sr-only"> — so far this week</span>}
    </>
  );
  const soFar = running && row ? `So far: ${weekSoFar(addWeeks(week, -1))} · updated ${new Date(row.updated_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : null;
  const title = [soFar, row?.note && row?.value != null ? row.note : isText ? shown : null, row?.origin === 'auto' ? 'Filled by the PIM' : null].filter(Boolean).join(' · ') || undefined;

  if (draft != null) {
    return (
      // The input takes the cell's own box (no minimum width, the button's
      // height): typing a number never widens the column or moves the row
      // (user, 2026-11-05). size={1}: an input's default 20-character width
      // would otherwise count in the table's column sizing.
      <td className={cn('border-b border-outline-variant p-0', tone)}>
        <input
          autoFocus
          size={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
          }}
          aria-label={`${label}${metric.unit === 'percent' ? ', in percent' : ''}`}
          className={cn('block w-full min-w-0 h-[2.25rem] px-2 rounded-sm border border-primary bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/30', isText ? 'text-left' : 'text-right tabular-nums')}
        />
      </td>
    );
  }
  return (
    <td className={cn('border-b border-outline-variant', tone)} title={title}>
      {longNote ? (
        // A long note (the AI's "Actions taken" note, a typed comment) opens in
        // full to read or copy (user, 2026-11-05); Edit is in the dialog when the cell is editable.
        <button
          type="button"
          onClick={() => setReading(true)}
          aria-label={`${label}: read the note`}
          className="w-full min-h-[2.25rem] px-2 py-1.5 text-left hover:bg-on-surface/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
        >
          {content}
        </button>
      ) : editable ? (
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
      {reading && (
        <NoteDialog
          title={metric.name}
          subtitle={`${weekTag(week)} · numbers of ${weekRange(addWeeks(week, -1))}${row?.origin === 'auto' ? ' · written by the PIM' : ''}`}
          text={shown}
          onClose={() => setReading(false)}
          onEdit={editable ? () => { setReading(false); setDraft(toInput(metric.unit, row)); } : null}
        />
      )}
    </td>
  );
}

/**
 * A note the PIM writes in blocks (a blank line between them): one card per
 * block, its first line as the heading, "Label: value" lines aligned and "• "
 * lines as a list. Any other note (a typed one) stays plain text.
 */
function NoteBody({ text }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.split('\n'));
  if (blocks.length < 2) return <p className="whitespace-pre-wrap select-text text-body-md text-on-surface leading-relaxed">{text}</p>;
  return (
    <div className="space-y-3 select-text">
      {blocks.map((lines, i) => {
        if (lines.length === 1) return <p key={i} className="text-body-md text-on-surface-variant">{lines[0]}</p>;
        const [title, drop] = lines[0].split(' — ');
        const fields = lines.slice(1).map((l) => l.match(/^([A-Z][A-Za-z ]+):\s*(.*)$/)).filter((m) => m && !m[0].startsWith('•') && m[2]);
        const bullets = lines.slice(1).filter((l) => l.startsWith('• ')).map((l) => l.slice(2));
        const listLabel = lines.slice(1).find((l) => /^[A-Z][A-Za-z ]+:$/.test(l))?.slice(0, -1);
        return (
          <section key={i} className="rounded-xl border border-outline-variant bg-surface-container-low p-3">
            <h3 className="flex items-baseline justify-between gap-3 text-label-lg font-semibold text-on-surface">
              <span>{title}</span>
              {drop && <span className="text-error whitespace-nowrap">{drop}</span>}
            </h3>
            {fields.length > 0 && (
              <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-body-sm">
                {fields.map((m) => (
                  <Fragment key={m[1]}>
                    <dt className="text-on-surface-variant">{m[1]}</dt>
                    <dd className="text-on-surface">{m[2]}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {bullets.length > 0 && (
              <div className="mt-2 text-body-sm">
                {listLabel && <p className="text-on-surface-variant">{listLabel}</p>}
                <ul className="mt-0.5 list-disc pl-4 space-y-0.5 text-on-surface">
                  {bullets.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A note in full: easy to read and to copy. In a portal (inside the <td> the
 * cell's tooltip showed over the text) into <main>, not <body>: there the
 * dialog's header became a second banner landmark.
 */
function NoteDialog({ title, subtitle, text, onClose, onEdit }) {
  const [copied, setCopied] = useState(null); // 'ok' | 'error'
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
  }
  return createPortal(
    <Dialog
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      maxWidth="max-w-xl"
      footer={(
        <>
          {copied && (
            <span role="status" className={cn('mr-auto text-body-sm', copied === 'ok' ? 'text-on-surface-variant' : 'text-error')}>
              {copied === 'ok' ? 'Copied to the clipboard.' : 'The browser did not let the page copy — select the text and copy it.'}
            </span>
          )}
          {onEdit && (
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
              <Pencil className="w-3.5 h-3.5" aria-hidden />
              Edit
            </button>
          )}
          <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity">
            {copied === 'ok' ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
            Copy
          </button>
        </>
      )}
    >
      <NoteBody text={text} />
    </Dialog>,
    document.getElementById('main-content') ?? document.body,
  );
}
