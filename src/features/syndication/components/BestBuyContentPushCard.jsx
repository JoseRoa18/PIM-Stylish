import { useEffect, useMemo, useState } from 'react';
import { Send, Loader2, AlertCircle, ChevronDown, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import Checkbox from '@/components/ui/Checkbox';
import { formatTimeAgo } from '@/lib/format';
import { loadBestBuyPushCandidates, pushBestBuyContent } from '../api/bestbuySync';

// Same normalization the audit card uses, so "differs" means the same thing
// in both cards.
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[""'’·×]/g, '"')
    .replace(/[^a-z0-9"]+/g, ' ')
    .trim();

/**
 * Manual content push: PIM → Best Buy (title, descriptions, images). The user
 * picks the SKUs — nothing is preselected and nothing runs on a schedule.
 * Prices never travel this path (the edge function enforces it too).
 */
export default function BestBuyContentPushCard() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [data, setData] = useState(undefined); // undefined = loading
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let active = true;
    loadBestBuyPushCandidates()
      .then((d) => { if (active) setData(d); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  const withDiff = useMemo(
    () => (data?.pushable ?? []).filter((c) => norm(c.bbTitle) !== norm(c.pimTitle)),
    [data],
  );
  const listed = showAll ? (data?.pushable ?? []) : withDiff;

  if (!canEdit) return null;

  const toggle = (sku) => {
    const next = new Set(selected);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setSelected(next);
  };

  async function handlePush() {
    const chosen = (data?.pushable ?? []).filter((c) => selected.has(c.sku));
    if (!chosen.length) return;
    const preview = chosen.slice(0, 6).map((c) => c.sku).join(', ') + (chosen.length > 6 ? ` … +${chosen.length - 6} more` : '');
    const ok = await confirm({
      title: `Push PIM content to ${chosen.length} Best Buy listing${chosen.length === 1 ? '' : 's'}?`,
      message: `${preview}. This sends the PIM's title, descriptions and images to Best Buy, overwriting their current content. Changes go through Best Buy's QC and appear asynchronously. Prices are not touched.`,
      confirmLabel: `Push ${chosen.length}`,
    });
    if (!ok) return;

    setBusy(true);
    setResult(null);
    setProgress({ done: 0, total: chosen.length });
    try {
      const res = await pushBestBuyContent(chosen, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult({
        type: res.linesError > 0 ? 'error' : 'success',
        message: res.linesError > 0
          ? `${res.linesOk} accepted, ${res.linesError} rejected by Mirakl (import${res.imports.length === 1 ? '' : 's'} ${res.imports.join(', ')}).`
          : `${res.linesOk} sent (import${res.imports.length === 1 ? '' : 's'} ${res.imports.join(', ')}). Best Buy applies them after QC.`,
        detail: res.errorsText || null,
      });
      if (res.linesError === 0) setSelected(new Set());
    } catch (err) {
      setResult({ type: 'error', message: err.message ?? 'Push failed' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2 flex-wrap">
        <Send className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Push Content</h2>
        <span className="text-label-md text-on-surface-variant">
          PIM → Best Buy · manual, content only, never prices
          {data?.runAt && <span> · snapshot {formatTimeAgo(data.runAt)}</span>}
        </span>
      </header>

      <div className="px-6 py-5 space-y-4">
        {error && (
          <p className="px-3 py-2 rounded-lg bg-error-container text-on-error-container text-body-sm">{error}</p>
        )}
        {data === undefined && !error && (
          <p className="text-body-sm text-on-surface-variant flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading candidates…
          </p>
        )}

        {data && (
          <>
            <div className="flex items-center gap-3 flex-wrap text-body-sm text-on-surface-variant">
              <span><span className="font-semibold text-on-surface">{data.pushable.length}</span> pushable</span>
              <span>· <span className="font-semibold text-on-surface">{withDiff.length}</span> with a different title on Best Buy</span>
              <span>· {data.excluded.length} not pushable yet</span>
              <label className="inline-flex items-center gap-1.5 ml-auto cursor-pointer select-none">
                <Checkbox checked={showAll} onChange={() => setShowAll(!showAll)} />
                show all pushable, not just title diffs
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set(listed.map((c) => c.sku)))}
                disabled={busy || !listed.length}
                className="px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
              >
                Select all shown
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={busy || !selected.size}
                className="px-3 py-1.5 rounded-lg text-label-md font-medium text-on-surface-variant hover:bg-surface-container-low transition-colors disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handlePush}
                disabled={busy || !selected.size}
                className="ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-on-primary text-label-md font-semibold hover:bg-primary/90 transition-colors disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {busy && progress ? `${progress.done}/${progress.total}` : `Push ${selected.size || ''}`}
              </button>
            </div>

            {result && (
              <div className={`px-3 py-2 rounded-lg text-body-sm flex items-start gap-2 ${
                result.type === 'success'
                  ? 'bg-secondary-container/60 text-on-secondary-container'
                  : 'bg-error-container text-on-error-container'
              }`}>
                {result.type === 'success'
                  ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  : <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                <div className="min-w-0">
                  <p>{result.message}</p>
                  {result.detail && (
                    <pre className="mt-1 text-label-sm whitespace-pre-wrap break-all opacity-80">{result.detail.slice(0, 600)}</pre>
                  )}
                </div>
              </div>
            )}

            {/* max-h + own scroll: this list can be 300 rows (data-lenis-prevent
                or the wheel dies inside main). */}
            <ul data-lenis-prevent className="max-h-96 overflow-y-auto divide-y divide-outline-variant rounded-xl border border-outline-variant">
              {listed.map((c) => (
                <li key={c.sku} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="pt-0.5">
                    <Checkbox checked={selected.has(c.sku)} onChange={() => toggle(c.sku)} disabled={busy} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-body-md text-on-surface font-mono">{c.sku}</span>
                    <div className="text-body-sm text-on-surface-variant truncate" title={c.bbTitle}>
                      BB: {c.bbTitle || '—'}
                    </div>
                    <div className="text-body-sm text-on-surface truncate" title={c.pimTitle}>
                      PIM: {c.pimTitle}
                    </div>
                  </div>
                </li>
              ))}
              {!listed.length && (
                <li className="px-4 py-6 text-center text-body-sm text-on-surface-variant">
                  {showAll ? 'Nothing pushable — run a Best Buy pull first.' : 'No title differences — switch on "show all" to push anyway.'}
                </li>
              )}
            </ul>

            {data.excluded.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowExcluded(!showExcluded)}
                  className="inline-flex items-center gap-1 text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showExcluded ? 'rotate-180' : ''}`} />
                  {data.excluded.length} not pushable yet
                </button>
                {showExcluded && (
                  <ul data-lenis-prevent className="mt-2 max-h-48 overflow-y-auto text-body-sm text-on-surface-variant space-y-0.5">
                    {data.excluded.map((e) => (
                      <li key={e.sku}><span className="font-mono text-on-surface">{e.sku}</span> — {e.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
