import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Download, Search } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';
import { categorizeScore } from '@/features/dashboard/lib/listingHealth';

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The detail behind a number. Two shapes:
 *  - activity: { products: [{ sku, name, count, destinations, actors, events[] }], byDestination, byActor }
 *  - scores:   { sections: [{ label, rows: [{ sku, name, score, before }] }] }
 * Always searchable, each product opens its events, and the list exports.
 */
export default function DetailDialog({ title, subtitle, activity, scores, onClose }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const needle = q.trim().toLowerCase();
  const match = (r) => !needle || r.sku.toLowerCase().includes(needle) || (r.name ?? '').toLowerCase().includes(needle);

  const products = useMemo(() => (activity?.products ?? []).filter(match), [activity, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => (scores?.sections ?? []).map((s) => ({ ...s, rows: s.rows.filter(match) })), [scores, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  function exportCsv() {
    const lines = [];
    if (activity) {
      lines.push(['SKU', 'Product', 'Count', 'Destinations', 'People', 'Last event']);
      for (const p of products) lines.push([p.sku, p.name ?? '', p.count, p.destinations.join(' | '), p.actors.join(' | '), p.last ?? '']);
      lines.push([], ['When', 'SKU', 'Who', 'What', 'Destination']);
      for (const p of products) for (const e of p.events) lines.push([e.at, p.sku, e.actor, e.summary, e.destination ?? '']);
    } else if (scores) {
      lines.push(['Section', 'SKU', 'Product', 'Score now', 'Score at week start']);
      for (const s of sections) for (const r of s.rows) lines.push([s.label, r.sku, r.name ?? '', r.score ?? '', r.before ?? '']);
    }
    const csv = lines.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const chips = activity
    ? [
        ...Object.entries(activity.byDestination).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: `${k} ${n}`, tone: 'accent' })),
        ...Object.entries(activity.byActor).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: `${k} ${n}`, tone: 'muted' })),
      ]
    : [];

  return (
    <Dialog onClose={onClose} title={title} subtitle={subtitle} maxWidth="max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by SKU or name…" className="pl-9 pr-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary w-64" />
        </div>
        <button type="button" onClick={exportCsv} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
          <Download className="w-4 h-4" />
          Export list
        </button>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {chips.map((c) => (
            <span key={c.label} className={`inline-flex items-center px-2.5 py-1 rounded-full text-label-md ${c.tone === 'accent' ? 'bg-primary-container/60 text-on-primary-container' : 'bg-surface-container text-on-surface-variant'}`}>{c.label}</span>
          ))}
        </div>
      )}

      {activity && (
        products.length === 0 ? (
          <p className="py-8 text-center text-body-sm text-on-surface-variant">{needle ? `Nothing matches "${q.trim()}".` : 'No events in this week.'}</p>
        ) : (
          <div className="rounded-xl border border-outline-variant overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                  <th className="text-left px-4 py-2.5 font-medium">Product</th>
                  <th className="text-left px-4 py-2.5 font-medium">Where / who</th>
                  <th className="text-right px-4 py-2.5 font-medium">Count</th>
                  <th className="text-right px-4 py-2.5 font-medium">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {products.map((p) => {
                  const isOpen = open === p.sku;
                  return (
                    <Fragment key={p.sku}>
                      <tr onClick={() => setOpen(isOpen ? null : p.sku)} aria-expanded={isOpen} className={`cursor-pointer transition-colors ${isOpen ? 'bg-surface-container-low/60' : 'hover:bg-surface-container-low/40'}`}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <ChevronDown className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            <div>
                              <Link to={`/catalog/${p.sku}`} onClick={(e) => e.stopPropagation()} className="text-body-md text-on-surface font-mono hover:text-primary">{p.sku}</Link>
                              {p.name && <div className="text-body-sm text-on-surface-variant truncate max-w-xs">{p.name}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-body-sm text-on-surface-variant">
                          {p.destinations.length ? <span className="text-on-surface">{p.destinations.join(', ')}</span> : null}
                          {p.destinations.length && p.actors.length ? ' · ' : ''}
                          {p.actors.map((a) => a.split('@')[0]).join(', ')}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-on-surface">{p.count}</td>
                        <td className="px-4 py-2.5 text-right text-body-sm text-on-surface-variant whitespace-nowrap">{p.last ? fmtWhen(p.last) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-surface-container-low/30">
                          <td colSpan={4} className="px-4 pb-3 pt-1">
                            <ul className="space-y-1 animate-banner-in">
                              {p.events.map((e, i) => (
                                <li key={i} className="text-body-sm text-on-surface flex items-baseline gap-2">
                                  <span className="text-on-surface-variant whitespace-nowrap tabular-nums w-28">{fmtWhen(e.at)}</span>
                                  <span className="text-on-surface-variant w-24 truncate">{e.actor}</span>
                                  <span className="min-w-0">{e.summary}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {scores && (
        <div className="space-y-5">
          {sections.map((s) => (
            <div key={s.label}>
              <p className="text-label-md font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">{s.label} · {s.rows.length}</p>
              {s.rows.length === 0 ? <p className="text-body-sm text-on-surface-variant">{s.empty ?? 'None.'}</p> : (
                <ul className="rounded-xl border border-outline-variant divide-y divide-outline-variant">
                  {s.rows.map((r) => (
                    <li key={r.sku} className="flex items-center justify-between gap-3 px-4 py-2 text-body-sm">
                      <Link to={`/catalog/${r.sku}`} className="text-on-surface hover:text-primary truncate"><span className="font-mono">{r.sku}</span>{r.name ? ` · ${r.name}` : ''}</Link>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        {r.before != null && r.before !== r.score && <span className="text-on-surface-variant tabular-nums">{r.before} →</span>}
                        {typeof r.score === 'number' && <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(r.score)]}`}>{r.score}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
