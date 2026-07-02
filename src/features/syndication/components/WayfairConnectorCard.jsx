import { useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck } from 'lucide-react';
import { pushContentToWayfair } from '../api/wayfairSync';

// Wayfair content syndication — Phase 1: push marketing copy + feature bullets.
// Defaults to validate-only (safe: validates the payload against Wayfair without
// changing anything). Needs the product's Wayfair itemGroupId.
export default function WayfairConnectorCard() {
  const [sku, setSku] = useState('');
  const [itemGroupId, setItemGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, message }

  async function run(validateOnly) {
    if (!sku.trim() || !itemGroupId.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await pushContentToWayfair(sku.trim(), { itemGroupId: itemGroupId.trim(), validateOnly });
      setResult({
        ok: true,
        message: validateOnly
          ? `Validated ✓ — ${data.pushed?.bullets ?? 0} bullets, copy ready (requestId ${data.requestId ?? '—'})`
          : `Pushed ✓ — requestId ${data.requestId ?? '—'}`,
      });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#7B189F]/15 text-[#7B189F] flex items-center justify-center font-bold">
            W
          </div>
          <div>
            <h2 className="text-title-md text-on-surface">Wayfair</h2>
            <p className="text-body-sm text-on-surface-variant">Push marketing copy + feature bullets (US)</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Sandbox
        </span>
      </div>

      <div className="px-6 py-5 space-y-3">
        <p className="text-body-sm text-on-surface-variant">
          Phase 1: content sync. Enter a product SKU and its Wayfair item-group id, then validate the
          payload against Wayfair (safe — nothing changes) or push it live.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Product SKU</span>
            <input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="K-135G"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Wayfair item-group id</span>
            <input
              value={itemGroupId}
              onChange={(e) => setItemGroupId(e.target.value)}
              placeholder="GTQE1086"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => run(true)}
            disabled={busy || !sku.trim() || !itemGroupId.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            Validate content
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy || !sku.trim() || !itemGroupId.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Push to Wayfair
          </button>
        </div>

        {result && (
          <div
            className={`flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm ${
              result.ok
                ? 'bg-primary-container/40 text-on-surface'
                : 'bg-error-container text-on-error-container'
            }`}
          >
            {result.ok ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            )}
            <span className="break-words">{result.message}</span>
          </div>
        )}
      </div>
    </section>
  );
}
