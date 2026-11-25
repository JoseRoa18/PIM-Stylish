import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import Pagination from '@/components/ui/Pagination';
import SCORE_BADGE_STYLES from '@/lib/scoreBadgeStyles';
import { categorizeScore } from '@/features/dashboard/lib/listingHealth';
import { loadChannelDetail } from '../api/kpi';
import { LISTING_FILTERS, checkInfo, compareListings, listingsOf, sortListings } from '../lib/progress';

const PAGE_SIZE = 25;
const SHOWN = 4; // issues named on a row before "+N more"

/**
 * The listings behind a row of Progress to 100%: which ones are left, which
 * are bad, which reached 100% in the selected week and which got worse — each
 * with what it fails. The PIM's detail is in its catalog snapshot; a
 * marketplace's is read here, for the two days being compared.
 */
export default function ListingsDialog({ row, week, names, initialFilter = 'left', exporting = false, onExport, onClose }) {
  const { scope, nowRow, beforeRow } = row;
  const [detail, setDetail] = useState(scope.kind === 'pim' ? { now: nowRow, before: beforeRow } : null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(initialFilter);
  const [picked, setPicked] = useState(''); // the check chosen in the list's "issue" choice
  const [order, setOrder] = useState(initialFilter === 'bad' ? 'worst' : 'closest');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);

  const nowDate = nowRow?.snapshot_date ?? null;
  const beforeDate = beforeRow?.snapshot_date ?? null;
  useEffect(() => {
    if (scope.kind === 'pim') return undefined;
    let active = true;
    loadChannelDetail([scope.key], [nowDate, beforeDate])
      .then((map) => { if (active) setDetail({ now: map.get(`${scope.key}|${nowDate}`) ?? null, before: map.get(`${scope.key}|${beforeDate}`) ?? null }); })
      .catch((err) => { if (active) setError(err); });
    return () => { active = false; };
  }, [scope, nowDate, beforeDate]);

  const compared = useMemo(() => (detail ? compareListings(listingsOf(detail.now), listingsOf(detail.before)) : null), [detail]);
  const hasDetail = !!detail && !!listingsOf(detail.now);
  const counts = useMemo(() => Object.fromEntries(LISTING_FILTERS.map((f) => [f.key, compared ? compared.rows.filter(f.test).length : 0])), [compared]);
  const active = LISTING_FILTERS.find((f) => f.key === filter) ?? LISTING_FILTERS[0];
  // What a row names: what it fails — or, among the listings that reached 100%, what was fixed.
  const named = (r) => (filter === 'reached' ? r.fixed : r.issues);

  const inFilter = useMemo(() => (compared ? compared.rows.filter(active.test) : []), [compared, active]);
  // The checks of the listings shown, most common first, for the "issue" choice.
  const checkOptions = useMemo(() => {
    const by = new Map();
    for (const r of inFilter) for (const k of named(r)) by.set(k, (by.get(k) ?? 0) + 1);
    return [...by.entries()].map(([key, n]) => ({ key, n, label: checkInfo(scope, key).label })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  }, [inFilter, filter, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  // A check the listings shown do not fail is no longer a choice.
  const check = checkOptions.some((c) => c.key === picked) ? picked : '';
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const rows = inFilter.filter((r) => (!check || named(r).includes(check))
      && (!needle || r.sku.toLowerCase().includes(needle) || (names.get(r.sku)?.model_name ?? '').toLowerCase().includes(needle)));
    return sortListings(rows, order);
  }, [inFilter, check, needle, order, names, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whatever changes the list goes back to its first page.
  const change = (set) => (value) => { set(value); setPage(1); setExpanded(null); };
  const setCheck = change(setPicked);
  const setSearch = change(setQ);

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const paged = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const tab = scope.kind === 'channel' ? 'marketplaces' : null;
  const productLink = (r) => {
    const first = scope.kind === 'pim' ? checkInfo(scope, r.issues[0])?.tab : tab;
    return `/catalog/${encodeURIComponent(r.sku)}${first && first !== 'overview' ? `?tab=${first}` : ''}`;
  };
  const nounPlural = `${scope.noun}s`;

  return (
    <Dialog
      onClose={onClose}
      title={`${scope.label} — ${nounPlural} left to reach 100%`}
      subtitle={`${week.name} · ${week.range}${compared?.hasBefore ? ' · compared with how it stood when the week began' : ''}`}
      maxWidth="max-w-5xl"
      footer={hasDetail ? (
        <>
          <Link to={`/listing-health?tab=${scope.kind === 'pim' ? 'pim' : scope.key}`} className="mr-auto self-center text-label-md text-primary font-semibold hover:underline">Open in Listing Health</Link>
          {onExport && (
            <button type="button" onClick={onExport} disabled={exporting} aria-busy={exporting} className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60">
              <Download className="w-4 h-4" aria-hidden="true" />
              {exporting ? 'Exporting…' : 'Export this list'}
            </button>
          )}
        </>
      ) : null}
    >
      {error ? (
        <p role="alert" className="rounded-xl bg-error-container text-on-error-container px-4 py-3 text-body-sm">{error.message}</p>
      ) : !detail ? (
        <div role="status" aria-label="Loading the listings" className="animate-pulse space-y-3">
          <div className="h-9 rounded-full bg-surface-container w-2/3" />
          <div className="h-64 rounded-xl bg-surface-container" />
        </div>
      ) : !hasDetail ? (
        <p className="py-8 text-center text-body-sm text-on-surface-variant">
          The list of {nounPlural} arrives with the next snapshot of {scope.label}. Until then, Listing Health has the live list.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={`Which ${nounPlural} to list`}>
            {LISTING_FILTERS.map((f) => {
              const off = f.needsBefore && !compared.hasBefore;
              const pressed = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={pressed}
                  disabled={off}
                  title={off ? 'Needs a snapshot from before the week began' : undefined}
                  onClick={() => { change(setFilter)(f.key); setOrder(f.key === 'bad' ? 'worst' : 'closest'); }}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-label-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${pressed ? 'border-primary bg-primary-container/30 text-on-surface font-semibold' : 'border-outline-variant text-on-surface hover:bg-surface-container-low'}`}
                >
                  {f.label}
                  <span className="tabular-nums text-on-surface-variant">{off ? '—' : counts[f.key]}</span>
                </button>
              );
            })}
          </div>

          {compared.hasBefore && (compared.fixed > 0 || compared.added > 0) && (
            <p className="mb-4 text-body-sm text-on-surface">
              In {week.name}: <span className="text-success font-semibold tabular-nums">{compared.fixed}</span> issue{compared.fixed === 1 ? '' : 's'} fixed
              {' · '}<span className={`${compared.added ? 'text-error' : 'text-on-surface-variant'} font-semibold tabular-nums`}>{compared.added}</span> new
              {compared.gone.length > 0 && <span className="text-on-surface-variant"> · {compared.gone.length} {compared.gone.length === 1 ? scope.noun : nounPlural} no longer scored</span>}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" aria-hidden="true" />
              <input type="text" value={q} onChange={(e) => setSearch(e.target.value)} placeholder="Search by SKU or name…" aria-label="Search by SKU or name" className="pl-9 pr-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary w-60 max-w-full" />
            </div>
            {checkOptions.length > 0 && (
              <select value={check} onChange={(e) => setCheck(e.target.value)} aria-label={filter === 'reached' ? 'What was fixed' : 'Which issue'} className="max-w-full px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary">
                <option value="">{filter === 'reached' ? 'Anything fixed' : 'Any issue'}</option>
                {checkOptions.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.n})</option>)}
              </select>
            )}
            <select value={order} onChange={(e) => change(setOrder)(e.target.value)} aria-label="Order" className="max-w-full px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary">
              <option value="closest">Closest to 100% first</option>
              <option value="worst">Lowest score first</option>
            </select>
          </div>

          {shown.length === 0 ? (
            <p role="status" className="py-8 text-center text-body-sm text-on-surface-variant">
              {needle || check ? 'Nothing matches.' : filter === 'left' ? `Every ${scope.noun} is at 100%.` : `No ${scope.noun} here.`}
            </p>
          ) : (
            <div className="rounded-xl border border-outline-variant overflow-hidden">
              {/* On a phone a row is the product with its score and its issues
                  under it; from sm they are columns of their own. */}
              <table className="w-full table-fixed sm:table-auto">
                <thead>
                  <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                    <th scope="col" className="text-left px-4 py-2.5 font-medium">Product<span className="sm:hidden"> · score · {filter === 'reached' ? 'fixed this week' : 'what is missing'}</span></th>
                    <th scope="col" className="hidden sm:table-cell text-right px-4 py-2.5 font-medium">Score</th>
                    <th scope="col" className="hidden sm:table-cell text-left px-4 py-2.5 font-medium">{filter === 'reached' ? 'Fixed this week' : 'What is missing'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {paged.map((r) => {
                    const keys = named(r);
                    const isOpen = expanded === r.sku;
                    const score = (
                      <>
                        {r.before != null && r.before !== r.score && <span className="text-body-sm text-on-surface-variant tabular-nums mr-2">{r.before} →</span>}
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-label-md font-semibold ${SCORE_BADGE_STYLES[categorizeScore(r.score)]}`}>{r.score}</span>
                      </>
                    );
                    const issues = (
                      <IssueChips
                        scope={scope}
                        sku={r.sku}
                        keys={keys}
                        added={r.isNew || filter === 'reached' ? [] : r.added}
                        fixed={filter === 'reached'}
                        open={isOpen}
                        onToggle={() => setExpanded(isOpen ? null : r.sku)}
                      />
                    );
                    return (
                      <tr key={r.sku}>
                        <td className="px-4 py-2.5 align-top">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <Link to={productLink(r)} className="inline-block py-[3px] -my-[3px] text-body-md text-on-surface font-mono hover:text-primary">{r.sku}</Link>
                              {names.get(r.sku)?.model_name && <div className="text-body-sm text-on-surface-variant truncate sm:max-w-[16rem]">{names.get(r.sku).model_name}</div>}
                            </div>
                            <div className="sm:hidden whitespace-nowrap">{score}</div>
                          </div>
                          <div className="sm:hidden mt-2">{issues}</div>
                        </td>
                        <td className="hidden sm:table-cell px-4 py-2.5 align-top text-right whitespace-nowrap">{score}</td>
                        <td className="hidden sm:table-cell px-4 py-2.5 align-top">{issues}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4">
            <Pagination page={current} pageSize={PAGE_SIZE} total={shown.length} onPageChange={setPage} compact label={`${scope.label} listings`} />
          </div>
        </>
      )}
    </Dialog>
  );
}

// What a listing fails (or, among those that reached 100%, what was fixed):
// the first few checks by name, the rest behind "+N more". A check it did not
// fail when the week began is marked new.
function IssueChips({ scope, sku, keys, added, fixed, open, onToggle }) {
  if (keys.length === 0) return <span className="text-body-sm text-on-surface-variant">Nothing: it is at 100%.</span>;
  const isNew = new Set(added);
  const visible = open ? keys : keys.slice(0, SHOWN);
  return (
    <ul className="flex flex-wrap gap-1.5">
      {visible.map((k) => {
        const c = checkInfo(scope, k);
        const tone = fixed ? 'bg-success-tint text-success' : isNew.has(k) ? 'bg-error-tint text-error' : 'bg-surface-container-high text-on-surface';
        return (
          <li key={k} title={c.where ?? undefined} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-label-md ${tone}`}>
            {c.label}
            {isNew.has(k) && <span className="font-semibold">· new</span>}
          </li>
        );
      })}
      {keys.length > SHOWN && (
        <li>
          <button type="button" aria-expanded={open} onClick={onToggle} className="inline-flex items-center px-2 py-0.5 rounded text-label-md text-primary font-semibold hover:underline">
            {open ? 'Show fewer' : `+${keys.length - SHOWN} more`}
            <span className="sr-only"> of {sku}</span>
          </button>
        </li>
      )}
    </ul>
  );
}
