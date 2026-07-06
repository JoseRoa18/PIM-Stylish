import { useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck, MinusCircle } from 'lucide-react';
import { pushToWayfair } from '../api/wayfairSync';

// Wayfair syndication tester — push a product's content (marketing copy +
// bullets) and images. Defaults to validate-only (safe: validates against
// Wayfair without changing anything).
export default function WayfairConnectorCard() {
  const [sku, setSku] = useState('');
  const [itemGroupId, setItemGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // full response | { error }

  async function run(validateOnly) {
    if (!sku.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await pushToWayfair(sku.trim(), {
        validateOnly,
        itemGroupId: itemGroupId.trim() || undefined,
      });
      setResult(data);
    } catch (err) {
      setResult({ error: err.message });
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
            <p className="text-body-sm text-on-surface-variant">Push marketing copy + feature bullets & images (US)</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Sandbox
        </span>
      </div>

      <div className="px-6 py-5 space-y-3">
        <p className="text-body-sm text-on-surface-variant">
          Enter a product SKU, then validate the payload against Wayfair (safe — nothing changes) or
          push it live. Content needs the product's Wayfair item-group id (stored on the product or
          entered below); images push by SKU.
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
            <span className="text-label-md text-on-surface-variant">Wayfair item-group id (optional)</span>
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
            disabled={busy || !sku.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            Validate
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy || !sku.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Push to Wayfair
          </button>
        </div>

        {result && <WayfairResult result={result} />}
      </div>
    </section>
  );
}

function WayfairResult({ result }) {
  if (result.error) {
    return (
      <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span className="break-words">{result.error}</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm">
      <ResultRow label="Content (copy + bullets)" part={result.content} okText={(c) => `${c.bullets ?? 0} bullets · ${c.requestId ? 'validated' : 'ok'}`} />
      <ResultRow label="Media (images)" part={result.media} okText={(m) => `${m.count ?? 0} images · ${m.requestId ? 'validated' : 'ok'}`} />
    </div>
  );
}

function ResultRow({ label, part, okText }) {
  let icon, text, cls;
  if (!part) {
    icon = <MinusCircle className="w-4 h-4 text-on-surface-variant" />;
    text = 'not run';
    cls = 'text-on-surface-variant';
  } else if (part.error) {
    icon = <AlertCircle className="w-4 h-4 text-error" />;
    text = part.error;
    cls = 'text-error';
  } else if (part.skipped) {
    icon = <MinusCircle className="w-4 h-4 text-on-surface-variant" />;
    text = part.skipped;
    cls = 'text-on-surface-variant';
  } else {
    icon = <CheckCircle2 className="w-4 h-4 text-primary" />;
    text = okText(part);
    cls = 'text-on-surface';
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="text-on-surface-variant">{label}: </span>
        <span className={`break-words ${cls}`}>{text}</span>
      </span>
    </div>
  );
}
