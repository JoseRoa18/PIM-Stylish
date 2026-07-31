import { useState } from 'react';
import {
  DollarSign, Loader2, RefreshCw, Send, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { formatCAD } from '@/lib/format';
import {
  previewBestBuyPriceSync,
  pushBestBuyPrices,
  getBestBuyImportStatus,
  refreshBestBuyOffers,
} from '../api/bestbuySync';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Price sync — the one write path to Best Buy. Loads the LIVE offers whose
 * price differs from the PIM MSRP, lets an admin/editor pick exactly which
 * SKUs to fix, and pushes price-only updates (async Mirakl import) after an
 * explicit confirmation. Everything else on this channel stays read-only.
 */
export default function BestBuyPriceSyncCard() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();

  const [preview, setPreview] = useState(null); // null = not loaded yet
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(null); // 'preview' | 'push' | 'import' | 'repull'
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!canEdit) return null;

  async function loadPreview() {
    setBusy(true);
    setPhase('preview');
    setError(null);
    setResult(null);
    try {
      const data = await previewBestBuyPriceSync();
      setPreview(data);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function toggle(sku) {
    const next = new Set(selected);
    if (next.has(sku)) next.delete(sku);
    else next.add(sku);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === preview.updates.length) setSelected(new Set());
    else setSelected(new Set(preview.updates.map((u) => u.sku)));
  }

  async function push() {
    const skus = [...selected];
    const ok = await confirm({
      title: `Push ${skus.length} price${skus.length === 1 ? '' : 's'} to Best Buy?`,
      message:
        'This updates the LIVE offers on the Best Buy Canada marketplace with the PIM MSRPs. ' +
        'Only the price changes — stock and offer state are untouched.\n\n' +
        skus.slice(0, 8).join(' · ') + (skus.length > 8 ? ` · +${skus.length - 8} more` : ''),
      confirmLabel: 'Push prices',
      destructive: true,
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPhase('push');
      const data = await pushBestBuyPrices(skus);
      if (!data.importId) {
        setResult({ done: true, pushed: 0, message: data.message ?? 'Nothing to push.' });
        return;
      }

      // Mirakl applies the import asynchronously — poll until it lands.
      setPhase('import');
      let status = null;
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        status = await getBestBuyImportStatus(data.importId);
        if (status.status === 'COMPLETE') break;
      }

      // Refresh the snapshot so Listing Health & the Dashboard see the fix.
      setPhase('repull');
      await refreshBestBuyOffers();

      setResult({
        done: true,
        pushed: data.updates.length,
        importId: data.importId,
        status: status?.status ?? 'UNKNOWN',
        linesInSuccess: status?.linesInSuccess ?? 0,
        linesInError: status?.linesInError ?? 0,
        errorReport: status?.errorReport ?? null,
      });
      setPreview(null);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  const PHASE_LABEL = {
    preview: 'Reading live offers…',
    push: 'Sending price updates…',
    import: 'Best Buy is applying the import…',
    repull: 'Refreshing the snapshot…',
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-on-surface-variant" />
        <h2 className="text-title-md text-on-surface">Price Sync</h2>
        <span className="text-label-md text-on-surface-variant">PIM MSRP → live offers</span>
      </header>

      <div className="px-6 py-5 space-y-4">
        {!preview && !result && (
          <p className="text-body-sm text-on-surface-variant">
            Load the live offers to see which prices differ from the PIM MSRP,
            pick the SKUs to fix, and push. Price only — stock and offer state
            are never touched.
          </p>
        )}

        {error && (
          <p className="px-3 py-2 rounded-lg bg-error-container text-on-error-container text-body-sm animate-banner-in">
            {error}
          </p>
        )}

        {busy && phase && (
          <p className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin" />
            {PHASE_LABEL[phase]}
          </p>
        )}

        {result && (
          <div className="px-3 py-2.5 rounded-lg bg-success-container/60 text-body-sm text-on-surface animate-banner-in space-y-1">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 text-success" />
              {result.pushed === 0
                ? result.message
                : `${result.pushed} price${result.pushed === 1 ? '' : 's'} pushed — import ${result.status}${
                    result.linesInError > 0 ? `, ${result.linesInError} line(s) in error` : ''
                  }`}
            </p>
            {result.errorReport && (
              <pre className="mt-1 p-2 rounded bg-surface-container text-label-md overflow-x-auto whitespace-pre-wrap">
                {result.errorReport}
              </pre>
            )}
          </div>
        )}

        {preview && (
          preview.updates.length === 0 ? (
            <p className="flex items-center gap-2 text-body-md text-on-surface animate-banner-in">
              <CheckCircle2 className="w-4 h-4 text-success" />
              All live prices match the PIM MSRP. ✨
            </p>
          ) : (
            <div className="animate-banner-in space-y-3">
              <p className="text-body-sm text-on-surface-variant">
                {preview.updates.length} of {preview.liveOffers} live offers differ from the PIM MSRP:
              </p>
              <div className="max-h-80 overflow-y-auto rounded-xl border border-outline-variant">
                <table className="w-full text-body-sm">
                  <thead className="sticky top-0 bg-surface-container-low">
                    <tr className="text-left text-label-md text-on-surface-variant">
                      <th className="px-3 py-2 w-10">
                        <input
                          type="checkbox"
                          checked={selected.size === preview.updates.length}
                          onChange={toggleAll}
                          aria-label="Select all"
                        />
                      </th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2 text-right">Best Buy</th>
                      <th className="px-3 py-2 text-right">PIM MSRP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant">
                    {preview.updates.map((u) => (
                      <tr
                        key={u.sku}
                        onClick={() => toggle(u.sku)}
                        className="cursor-pointer hover:bg-surface-container-low/40 transition-colors"
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selected.has(u.sku)}
                            onChange={() => toggle(u.sku)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${u.sku}`}
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-on-surface">{u.sku}</td>
                        <td className="px-3 py-2 text-right text-error tabular-nums">{formatCAD(u.from)}</td>
                        <td className="px-3 py-2 text-right text-on-surface font-medium tabular-nums">{formatCAD(u.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={loadPreview}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${busy && phase === 'preview' ? 'animate-spin' : ''}`} />
            {preview ? 'Reload live preview' : 'Load live preview'}
          </button>

          {preview && preview.updates.length > 0 && (
            <button
              type="button"
              onClick={push}
              disabled={busy || selected.size === 0}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              Push {selected.size > 0 ? selected.size : ''} selected
            </button>
          )}
        </div>

        <p className="flex items-start gap-2 text-label-md text-on-surface-variant border-t border-outline-variant pt-3">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          This is the only write to Best Buy, and it goes to the LIVE
          marketplace. Start with one SKU to validate the flow end to end.
        </p>
      </div>
    </section>
  );
}
