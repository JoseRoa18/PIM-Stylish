import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ScanSearch, AlertCircle, OctagonX, CheckCircle2 } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { formatTimeAgo, formatCategory } from '@/lib/format';
import { latestSnapshot } from '../lib/channels';
import { pushWayfairAttributes } from '../api/wayfairSync';
import Dialog from '@/components/ui/Dialog';

// Catalog-wide spec-attributes audit: runs the per-SKU attribute diff
// (dryRun — reads Wayfair, changes nothing) across the WHOLE catalog and
// aggregates the discrepancies, so nobody has to check product by product.
// The edge function resolves each item's Wayfair class at runtime, so every
// category audits the attributes its class carries; SKUs with no Wayfair
// listing simply land in the "not audited" list. The PIM is the source of
// truth: differences are fixed by pushing FROM the PIM, never by copying
// Wayfair values in.

const TARGETS = {
  CAN_CA: { supplier: 'CAN', market: 'CA', label: 'Canada — English (CAN)' },
  CAN_CA_FR: { supplier: 'CAN', market: 'CA_FR', label: 'Canada — French (CAN)' },
  USA_US: { supplier: 'USA', market: 'US', label: 'USA (StylishUSAInc)' },
};
const CONCURRENCY = 3;

export default function WayfairAuditCard() {
  const [target, setTarget] = useState('CAN_CA');
  const [run, setRun] = useState(null); // { busy, done, total, rows, errors }
  const [push, setPush] = useState(null); // { busy, done, total, ok, failed }
  const [lastSnap, setLastSnap] = useState(null); // latest channel_health snapshot (read-only)
  const [detailSku, setDetailSku] = useState(null); // per-SKU value diff modal
  const [expanded, setExpanded] = useState(false); // header always shows the summary; the list is on demand
  const [snapQuery, setSnapQuery] = useState(''); // search within the last-audit list
  const [snapCat, setSnapCat] = useState(''); // category filter for the list
  const [catBySku, setCatBySku] = useState(null); // sku → PIM category
  const cancelRef = useRef(false);

  // Categories for the last-audit filter (snapshot rows carry no category).
  useEffect(() => {
    let active = true;
    supabase.from('products').select('sku, category').then(({ data }) => {
      if (active && data) setCatBySku(new Map(data.map((p) => [p.sku, p.category])));
    });
    return () => { active = false; };
  }, []);

  // Surface the last persisted audit so the channel's freshness is visible
  // without re-running the ~1 min live audit.
  useEffect(() => {
    let active = true;
    latestSnapshot('wayfair').then((s) => { if (active) setLastSnap(s); });
    return () => { active = false; };
  }, []);

  // Fix every discrepancy at once: push the PIM's spec attributes for each
  // SKU the audit flagged. (Against the sandbox this is processed by Wayfair
  // as validation — production credentials are what make it stick.)
  async function pushAllDiffs(diffRows) {
    cancelRef.current = false;
    const { supplier, market } = TARGETS[target];
    const targets = diffRows.map((r) => r.sku);
    const state = { busy: true, done: 0, total: targets.length, ok: 0, failed: [], startedAt: Date.now() };
    setPush({ ...state });

    let cursor = 0;
    async function worker() {
      while (cursor < targets.length && !cancelRef.current) {
        const sku = targets[cursor++];
        try {
          await pushWayfairAttributes(sku, { validateOnly: false, supplier, market });
          state.ok += 1;
        } catch (err) {
          state.failed.push({ sku, message: err.message });
        }
        state.done += 1;
        setPush({ ...state, failed: [...state.failed] });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    state.busy = false;
    setPush({ ...state, failed: [...state.failed] });
  }

  async function startAudit() {
    cancelRef.current = false;
    setPush(null);
    const { supplier, market } = TARGETS[target];

    // Whole catalog — the edge function handles every Wayfair class; items
    // Wayfair doesn't know land in the errors list, not in the results.
    const { data: products, error } = await supabase
      .from('products')
      .select('sku')
      .order('category')
      .order('sku');
    if (error) {
      setRun({ busy: false, error: error.message, rows: [], errors: [] });
      return;
    }

    const skus = products.map((p) => p.sku);
    const state = { busy: true, done: 0, total: skus.length, rows: [], errors: [], startedAt: Date.now() };
    setRun({ ...state });

    let cursor = 0;
    async function worker() {
      while (cursor < skus.length && !cancelRef.current) {
        const sku = skus[cursor++];
        try {
          const res = await pushWayfairAttributes(sku, { dryRun: true, supplier, market });
          state.rows.push({
            sku,
            changed: res.changedCount ?? 0,
            mapped: res.updates ?? 0,
            diff: res.diff ?? {},
          });
        } catch (err) {
          state.errors.push({ sku, message: err.message });
        }
        state.done += 1;
        setRun({ ...state, rows: [...state.rows], errors: [...state.errors] });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    state.busy = false;
    setRun({ ...state, rows: [...state.rows], errors: [...state.errors] });

    // Persist a snapshot (best-effort) so Listing Health can show channel
    // sync at a glance without re-running the ~1 min live audit.
    try {
      const offenders = state.rows
        .filter((r) => r.changed > 0)
        .sort((a, b) => b.changed - a.changed)
        .slice(0, 10)
        .map((r) => ({
          sku: r.sku,
          changed: r.changed,
          fields: Object.entries(r.diff).filter(([, d]) => d.changed).slice(0, 4).map(([t]) => t),
        }));
      await supabase.from('channel_health').insert({
        channel: 'wayfair',
        target: `${supplier}/${market}`,
        total: state.total,
        in_sync: state.rows.filter((r) => r.changed === 0).length,
        with_diffs: state.rows.filter((r) => r.changed > 0).length,
        errors: state.errors.length,
        partial: state.done < state.total,
        top_offenders: offenders,
        // Full per-SKU outcome (incl. which attributes differ) so Listing
        // Health can score every product and show the exact fields.
        results: state.rows.map((r) => ({
          sku: r.sku,
          changed: r.changed,
          fields: Object.entries(r.diff).filter(([, d]) => d.changed).map(([t]) => t),
        })),
      });
    } catch (err) {
      console.error('channel_health snapshot:', err);
    }
  }

  const rows = run?.rows ?? [];
  const withDiffs = rows.filter((r) => r.changed > 0).sort((a, b) => b.changed - a.changed);
  const clean = rows.length - withDiffs.length;

  // The persisted snapshot carries the full per-SKU outcome of the LAST
  // audit (cron or manual), so the diff list shows the moment the card
  // opens — a live re-run is only needed for value-level detail.
  const snapDiffs = (lastSnap?.results ?? [])
    .filter((r) => r.changed > 0)
    .sort((a, b) => b.changed - a.changed);

  // Search (SKU or attribute name) + category filter over the last audit.
  const q = snapQuery.trim().toLowerCase();
  const snapFiltered = snapDiffs.filter((r) => {
    if (snapCat && catBySku?.get(r.sku) !== snapCat) return false;
    if (!q) return true;
    return r.sku.toLowerCase().includes(q) ||
      (r.fields ?? []).some((f) => String(f).toLowerCase().includes(q));
  });
  const snapCategories = [...new Set(snapDiffs.map((r) => catBySku?.get(r.sku)).filter(Boolean))].sort();

  // ETA from the observed pace (needs a few samples to stabilize). The
  // component re-renders on every finished SKU, which keeps this fresh.
  const etaOf = (s) => {
    if (!s?.busy || s.done < 3 || !s.startedAt) return null;
    // Intentionally impure: the component re-renders on every finished SKU, so
    // reading the clock here keeps the ETA fresh without a ticker interval.
    // eslint-disable-next-line react-hooks/purity
    const remainMs = ((Date.now() - s.startedAt) / s.done) * (s.total - s.done);
    const mins = Math.floor(remainMs / 60000);
    const secs = Math.round((remainMs % 60000) / 1000);
    return mins > 0 ? `${mins} min ${String(secs).padStart(2, '0')} s` : `${secs} s`;
  };
  const eta = etaOf(run);
  const pushEta = etaOf(push);

  // A live run keeps the body visible regardless of the collapse state.
  const bodyVisible = expanded || Boolean(run);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header
        onClick={(e) => {
          if (e.target.closest('button, select, input, a')) return;
          setExpanded((v) => !v);
        }}
        className="px-6 pt-5 pb-4 flex items-start justify-between gap-4 flex-wrap cursor-pointer"
      >
        <div>
          <h3 className="text-title-lg text-on-surface">Spec attributes audit</h3>
          <p className="text-body-sm text-on-surface-variant mt-1 max-w-lg">
            Compares every product's spec attributes against Wayfair — all categories,
            each audited on its own Wayfair class — and lists the differences.
            Read-only, nothing changes. Fix diffs by pushing from the PIM
            (the PIM is the source of truth).
          </p>
          {!run && lastSnap && (
            <p className="text-body-sm text-on-surface-variant mt-2 tabular-nums">
              Last audit {formatTimeAgo(lastSnap.run_at)}
              {lastSnap.target && <span> ({lastSnap.target})</span>}
              {' '}· {lastSnap.in_sync} in sync · {lastSnap.with_diffs} with differences
              {lastSnap.errors > 0 && <span> · {lastSnap.errors} not audited</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={run?.busy}
            className="px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {Object.entries(TARGETS).map(([key, t]) => (
              <option key={key} value={key}>{t.label}</option>
            ))}
          </select>
          {run?.busy ? (
            <button
              type="button"
              onClick={() => { cancelRef.current = true; }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
            >
              <ThinkingOrb state="searching" size={20} className="w-4 h-4" />
              Stop ({run.done}/{run.total})
            </button>
          ) : (
            <button
              type="button"
              onClick={startAudit}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
            >
              <ScanSearch className="w-4 h-4" />
              Audit all products
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={bodyVisible}
            aria-label={bodyVisible ? 'Collapse audit results' : 'Expand audit results'}
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${bodyVisible ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </header>

      {/* Last-audit results, straight from the persisted snapshot — what's
          wrong per product plus the mass push, with zero waiting. */}
      {bodyVisible && !run && snapDiffs.length > 0 && (
        <div className="border-t border-outline-variant">
          <div className="px-6 py-3 flex items-center gap-3 flex-wrap text-body-sm bg-surface-container-low/50">
            <span className="inline-flex items-center gap-1.5 text-on-surface whitespace-nowrap">
              <AlertCircle className="w-4 h-4 text-warning" />
              {snapFiltered.length === snapDiffs.length
                ? `${snapDiffs.length} with differences`
                : `${snapFiltered.length} of ${snapDiffs.length} with differences`}
            </span>
            <input
              type="text"
              value={snapQuery}
              onChange={(e) => setSnapQuery(e.target.value)}
              placeholder="Filter by SKU or attribute…"
              className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm w-56 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <select
              value={snapCat}
              onChange={(e) => setSnapCat(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {snapCategories.map((c) => (
                <option key={c} value={c}>{formatCategory(c)}</option>
              ))}
            </select>
            <span className="ml-auto inline-flex items-center gap-3">
              {push && !push.busy && (
                <span className="text-body-sm text-on-surface animate-banner-in">
                  Pushed {push.ok}/{push.total}
                  {push.failed.length > 0 && <span className="text-error"> · {push.failed.length} failed</span>}
                </span>
              )}
              {push?.busy ? (
                <button
                  type="button"
                  onClick={() => { cancelRef.current = true; }}
                  className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
                >
                  <ThinkingOrb state="working" size={20} className="w-4 h-4" />
                  <span className="tabular-nums">
                    Pushing… {push.done}/{push.total}
                    {pushEta && <span> · ~{pushEta} left</span>}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => pushAllDiffs(snapFiltered)}
                  disabled={snapFiltered.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {snapFiltered.length === snapDiffs.length
                    ? `Push all ${snapDiffs.length} from PIM`
                    : `Push ${snapFiltered.length} filtered from PIM`}
                </button>
              )}
            </span>
          </div>
          <ul className="divide-y divide-outline-variant max-h-[26rem] overflow-y-auto scrollbar-slim" data-lenis-prevent>
            {snapFiltered.length === 0 && (
              <li className="px-6 py-4 text-body-sm text-on-surface-variant">
                Nothing matches that filter.
              </li>
            )}
            {snapFiltered.map((r) => (
              <li key={r.sku}>
                {/* Opens the value-level diff (a live single-SKU dry run —
                    a second or two, always fresh). */}
                <button
                  type="button"
                  onClick={() => setDetailSku(r.sku)}
                  className="w-full flex items-center gap-3 px-6 py-2.5 text-left hover:bg-surface-container-low/60 transition-colors"
                >
                  <span className="font-mono text-body-sm text-on-surface">{r.sku}</span>
                  <span className="px-2 py-0.5 rounded-full bg-warning-container text-on-warning-container text-label-md whitespace-nowrap">
                    {r.changed} diff{r.changed === 1 ? '' : 's'}
                  </span>
                  <span
                    className="text-body-sm text-on-surface-variant truncate flex-1"
                    title={(r.fields ?? []).join(' · ')}
                  >
                    {(r.fields ?? []).join(' · ')}
                  </span>
                  <ArrowRight className="w-4 h-4 text-on-surface-variant flex-shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {detailSku && (
        <DiffDetailDialog
          sku={detailSku}
          supplier={TARGETS[target].supplier}
          market={TARGETS[target].market}
          onClose={() => setDetailSku(null)}
        />
      )}

      {run && (
        <div className="border-t border-outline-variant">
          {/* Summary */}
          <div className="px-6 py-3 flex items-center gap-4 flex-wrap text-body-sm bg-surface-container-low/50">
            <span className="inline-flex items-center gap-1.5 text-on-surface">
              <CheckCircle2 className="w-4 h-4 text-success" /> {clean} in sync
            </span>
            <span className="inline-flex items-center gap-1.5 text-on-surface">
              <AlertCircle className="w-4 h-4 text-warning" /> {withDiffs.length} with differences
            </span>
            {run.errors.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-on-surface">
                <OctagonX className="w-4 h-4 text-error" /> {run.errors.length} not audited
              </span>
            )}
            {run.busy && (
              <span className="text-on-surface-variant ml-auto tabular-nums">
                Checking… {run.done}/{run.total}
                {eta && <span> · ~{eta} left</span>}
              </span>
            )}
            {!run.busy && withDiffs.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-3">
                {push && !push.busy && (
                  <span className="text-body-sm text-on-surface animate-banner-in">
                    Pushed {push.ok}/{push.total}
                    {push.failed.length > 0 && <span className="text-error"> · {push.failed.length} failed</span>}
                  </span>
                )}
                {push?.busy ? (
                  <button
                    type="button"
                    onClick={() => { cancelRef.current = true; }}
                    className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
                  >
                    <ThinkingOrb state="working" size={20} className="w-4 h-4" />
                    <span className="tabular-nums">
                      Pushing… {push.done}/{push.total}
                      {pushEta && <span> · ~{pushEta} left</span>}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => pushAllDiffs(withDiffs)}
                    className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
                  >
                    Push all {withDiffs.length} from PIM
                  </button>
                )}
              </span>
            )}
          </div>

          {/* Progress bar */}
          {run.busy && (
            <div className="h-1 bg-surface-container-high" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
              <div
                className="h-full bg-primary transition-[width] duration-500 [transition-timing-function:var(--ease-out-cubic)]"
                style={{ width: `${(run.done / Math.max(run.total, 1)) * 100}%` }}
              />
            </div>
          )}

          {withDiffs.length > 0 && (
            <ul className="divide-y divide-outline-variant">
              {withDiffs.map((r) => (
                <AuditRow key={r.sku} row={r} />
              ))}
            </ul>
          )}

          {run.errors.length > 0 && (
            <details className="px-6 py-3 border-t border-outline-variant text-body-sm">
              <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                {run.errors.length} SKU(s) could not be audited (no Wayfair listing…)
              </summary>
              <ul className="mt-2 space-y-0.5 text-on-surface-variant">
                {run.errors.map((e) => (
                  <li key={e.sku}>
                    <span className="font-mono text-on-surface">{e.sku}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {!run.busy && rows.length > 0 && withDiffs.length === 0 && (
            <p className="px-6 py-4 text-body-sm text-on-surface animate-banner-in">
              Every audited product matches the PIM. Nothing to fix.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// Value-level diff for ONE SKU: a live dry-run against Wayfair (fresh, ~1-2s)
// showing what Wayfair has now vs what the PIM will push — with the fix
// button right there.
function DiffDetailDialog({ sku, supplier, market, onClose }) {
  const [state, setState] = useState({ busy: true });
  const [pushState, setPushState] = useState(null); // null | 'busy' | 'ok' | error string

  // The dialog mounts fresh per SKU (conditional render), so the initial
  // busy state covers the load — no sync setState needed here.
  useEffect(() => {
    let active = true;
    pushWayfairAttributes(sku, { dryRun: true, supplier, market })
      .then((res) => { if (active) setState({ busy: false, diff: res.diff ?? {} }); })
      .catch((err) => { if (active) setState({ busy: false, error: err.message }); });
    return () => { active = false; };
  }, [sku, supplier, market]);

  const changes = Object.entries(state.diff ?? {}).filter(([, d]) => d.changed);

  async function pushThis() {
    setPushState('busy');
    try {
      await pushWayfairAttributes(sku, { validateOnly: false, supplier, market });
      setPushState('ok');
    } catch (err) {
      setPushState(err.message ?? 'Push failed');
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title={sku}
      subtitle="Wayfair (current) → PIM (what a push will set)"
      maxWidth="max-w-lg"
    >
      {state.busy ? (
        <p className="text-body-sm text-on-surface-variant inline-flex items-center gap-2 py-2">
          <ThinkingOrb state="searching" size={20} className="w-4 h-4" />
          Reading current values from Wayfair…
        </p>
      ) : state.error ? (
        <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{state.error}</p>
      ) : (
        <div className="space-y-3">
          {changes.length === 0 ? (
            <p className="text-body-sm text-on-surface py-1">
              Already in sync. The last audit's diff has been resolved.
            </p>
          ) : (
            <ul className="rounded-xl border border-outline-variant divide-y divide-outline-variant max-h-[50vh] overflow-y-auto scrollbar-slim" data-lenis-prevent>
              {changes.map(([title, d]) => (
                <li key={title} className="px-4 py-2.5 text-body-sm">
                  <div className="text-on-surface font-medium">{title}</div>
                  <div className="mt-0.5 text-on-surface-variant">
                    {d.current?.length ? d.current.join('; ') : '(empty at Wayfair)'}
                    {' '}→ <span className="text-primary font-semibold">{String(d.new)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Link
              to={`/catalog/${encodeURIComponent(sku)}?tab=marketplaces`}
              onClick={onClose}
              className="text-body-sm text-primary font-semibold hover:underline"
            >
              Open product →
            </Link>
            {changes.length > 0 && (
              pushState === 'ok' ? (
                <span className="inline-flex items-center gap-1.5 text-body-sm text-on-surface animate-banner-in">
                  <CheckCircle2 className="w-4 h-4 text-success" /> Pushed from PIM
                </span>
              ) : pushState === 'busy' ? (
                <span className="inline-flex items-center gap-2 text-body-sm text-on-surface-variant">
                  <ThinkingOrb state="working" size={20} className="w-4 h-4" /> Pushing…
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  {typeof pushState === 'string' && pushState !== 'ok' && pushState !== 'busy' && (
                    <span className="text-body-sm text-error">{pushState}</span>
                  )}
                  <button
                    type="button"
                    onClick={pushThis}
                    className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
                  >
                    Push this SKU from PIM
                  </button>
                </span>
              )
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function AuditRow({ row }) {
  const [open, setOpen] = useState(false);
  const changes = Object.entries(row.diff).filter(([, d]) => d.changed);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-6 py-2.5 text-left hover:bg-surface-container-low/60 transition-colors"
      >
        <span className="font-mono text-body-sm text-on-surface">{row.sku}</span>
        <span className="px-2 py-0.5 rounded-full bg-warning-container text-on-warning-container text-label-md">
          {row.changed} diff{row.changed === 1 ? '' : 's'}
        </span>
        <span className="text-body-sm text-on-surface-variant truncate flex-1">
          {changes.slice(0, 3).map(([t]) => t).join(' · ')}{changes.length > 3 ? ' …' : ''}
        </span>
        <ChevronDown className={`w-4 h-4 text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className={`grid transition-[grid-template-rows] ${open ? 'grid-rows-[1fr] duration-300 [transition-timing-function:var(--ease-out-quint)]' : 'grid-rows-[0fr] duration-200 ease-in'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="px-6 pb-3 text-body-sm">
            <ul className="space-y-0.5 text-on-surface-variant">
              {changes.map(([title, d]) => (
                <li key={title}>
                  <span className="text-on-surface">{title}</span>:{' '}
                  {d.current?.length ? d.current.join('; ') : '(empty at Wayfair)'} →{' '}
                  <span className="text-primary font-semibold">{String(d.new)}</span>
                </li>
              ))}
            </ul>
            <Link
              to={`/catalog/${encodeURIComponent(row.sku)}?tab=marketplaces`}
              className="inline-block mt-2 text-primary font-semibold hover:underline"
            >
              Open product → push from PIM
            </Link>
          </div>
        </div>
      </div>
    </li>
  );
}
