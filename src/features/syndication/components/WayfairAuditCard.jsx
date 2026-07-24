import { useRef, useState } from 'react';
import { ChevronDown, ScanSearch, AlertCircle, OctagonX, CheckCircle2 } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { pushWayfairAttributes } from '../api/wayfairSync';

// Catalog-wide spec-attributes audit: runs the per-SKU attribute diff
// (dryRun — reads Wayfair, changes nothing) across every kitchen sink and
// aggregates the discrepancies, so nobody has to check product by product.
// The PIM is the source of truth: differences are fixed by pushing FROM the
// product page, never by copying Wayfair values in.

const TARGETS = {
  CAN_CA: { supplier: 'CAN', market: 'CA', label: 'Canada — English (CAN_Stylish)' },
  CAN_CA_FR: { supplier: 'CAN', market: 'CA_FR', label: 'Canada — French (CAN_Stylish)' },
  USA_US: { supplier: 'USA', market: 'US', label: 'USA (StylishUSAInc)' },
};
const CONCURRENCY = 3;

export default function WayfairAuditCard() {
  const [target, setTarget] = useState('CAN_CA');
  const [run, setRun] = useState(null); // { busy, done, total, rows, errors }
  const [push, setPush] = useState(null); // { busy, done, total, ok, failed }
  const cancelRef = useRef(false);

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

    // Spec attributes only exist for Wayfair's Kitchen Sinks class so far.
    const { data: products, error } = await supabase
      .from('products')
      .select('sku')
      .eq('category', 'kitchen_sink')
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
  }

  const rows = run?.rows ?? [];
  const withDiffs = rows.filter((r) => r.changed > 0).sort((a, b) => b.changed - a.changed);
  const clean = rows.length - withDiffs.length;

  // ETA from the observed pace (needs a few samples to stabilize). The
  // component re-renders on every finished SKU, which keeps this fresh.
  const etaOf = (s) => {
    if (!s?.busy || s.done < 3 || !s.startedAt) return null;
    const remainMs = ((Date.now() - s.startedAt) / s.done) * (s.total - s.done);
    const mins = Math.floor(remainMs / 60000);
    const secs = Math.round((remainMs % 60000) / 1000);
    return mins > 0 ? `${mins} min ${String(secs).padStart(2, '0')} s` : `${secs} s`;
  };
  const eta = etaOf(run);
  const pushEta = etaOf(push);

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 pt-5 pb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-title-lg text-on-surface">Spec attributes audit</h3>
          <p className="text-body-sm text-on-surface-variant mt-1 max-w-lg">
            Compares every kitchen sink's spec attributes against Wayfair and lists the
            differences — read-only, nothing changes. Fix diffs by pushing from each
            product's page (the PIM is the source of truth).
          </p>
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
              Audit all kitchen sinks
            </button>
          )}
        </div>
      </header>

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
                {run.errors.length} SKU(s) could not be audited (no Wayfair listing, other classes…)
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
              Every audited sink matches the PIM. Nothing to fix. ✨
            </p>
          )}
        </div>
      )}
    </section>
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
