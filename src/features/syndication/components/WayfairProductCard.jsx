import { useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck, MinusCircle, Save } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { pushToWayfair, setWayfairItemGroupId } from '../api/wayfairSync';
import { formatTimeAgo } from '@/lib/format';

// Per-product Wayfair panel (Marketplaces tab): store the item-group id, then
// validate or push content (copy + bullets) and images. Validate is a safe
// dry-run.
export default function WayfairProductCard({ product, onUpdate }) {
  const [groupId, setGroupId] = useState(product.wayfair_item_group_id ?? '');
  const [savingId, setSavingId] = useState(false);
  const [busy, setBusy] = useState(null); // 'validate' | 'push' | null
  const [result, setResult] = useState(null);

  const dirty = (groupId.trim() || null) !== (product.wayfair_item_group_id ?? null);

  async function saveGroupId() {
    setSavingId(true);
    try {
      await setWayfairItemGroupId(product.sku, groupId);
      onUpdate?.({ wayfair_item_group_id: groupId.trim() || null });
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSavingId(false);
    }
  }

  async function run(validateOnly) {
    setBusy(validateOnly ? 'validate' : 'push');
    setResult(null);
    try {
      const data = await pushToWayfair(product.sku, {
        validateOnly,
        itemGroupId: groupId.trim() || undefined,
      });
      setResult(data);
      if (!validateOnly) onUpdate?.({ wayfair_synced_at: new Date().toISOString() });
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#7B189F]/15 text-[#7B189F] dark:bg-[#7B189F]/30 dark:text-[#CE93E8] flex items-center justify-center font-bold">
            W
          </div>
          <div>
            <h2 className="text-title-md text-on-surface">Wayfair</h2>
            <p className="text-body-sm text-on-surface-variant">
              {product.wayfair_synced_at
                ? `Last pushed ${formatTimeAgo(product.wayfair_synced_at)}`
                : 'Not pushed yet'}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Sandbox
        </span>
      </div>

      <div className="px-6 py-5 space-y-3">
        <label className="block">
          <span className="text-label-md text-on-surface-variant">Wayfair item-group id (for content)</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              placeholder="GTQE1086 — needed to push copy + bullets"
              className="flex-1 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              type="button"
              onClick={saveGroupId}
              disabled={savingId || !dirty}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-outline-variant text-label-md hover:bg-surface-container-low transition-colors disabled:opacity-40"
            >
              {savingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save
            </button>
          </div>
        </label>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!!busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            {busy === 'validate' ? <ThinkingOrb state="solving" size={20} className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
            Validate
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={!!busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {busy === 'push' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Push to Wayfair
          </button>
        </div>

        {result &&
          (result.error ? (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{result.error}</span>
            </div>
          ) : (
            <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm">
              <ResultRow label="Content (copy + bullets)" part={result.content} okText={(c) => `${c.bullets ?? 0} bullets · validated`} />
              <ResultRow label="Media (images)" part={result.media} okText={(m) => `${m.count ?? 0} images · validated`} />
            </div>
          ))}
      </div>
    </section>
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
