import { useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, ShieldCheck, MinusCircle, DownloadCloud } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { pushToWayfair, pullWayfairItemGroups, checkWayfairRequestStatus, pushWayfairAttributes } from '../api/wayfairSync';

// Wayfair syndication tester — push a product's content (marketing copy +
// bullets) and images. Defaults to validate-only (safe: validates against
// Wayfair without changing anything).
export default function WayfairConnectorCard() {
  const [sku, setSku] = useState('');
  const [target, setTarget] = useState('CAN_CA'); // supplier + storefront
  const [itemGroupId, setItemGroupId] = useState('');

  // One dropdown covers both supplier accounts and their storefronts.
  const TARGETS = {
    CAN_CA: { supplier: 'CAN', market: 'CA', label: 'Canada — English (CAN_Stylish)' },
    CAN_CA_FR: { supplier: 'CAN', market: 'CA_FR', label: 'Canada — French (CAN_Stylish)' },
    USA_US: { supplier: 'USA', market: 'US', label: 'USA (StylishUSAInc)' },
  };
  const { supplier, market } = TARGETS[target];
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // full response | { error }
  const [pull, setPull] = useState(null); // { busy, done, total, summary?, error? }
  const [attrs, setAttrs] = useState(null); // attribute-push response | { error }
  const [attrsBusy, setAttrsBusy] = useState(false);

  async function runAttrs(validateOnly) {
    if (!sku.trim()) return;
    setAttrsBusy(true);
    setAttrs(null);
    try {
      const data = await pushWayfairAttributes(sku.trim(), {
        validateOnly,
        supplier,
        market: market === 'CA_FR' ? 'CA' : market, // attrs are language-neutral
      });
      setAttrs(data);
    } catch (err) {
      setAttrs({ error: err.message });
    } finally {
      setAttrsBusy(false);
    }
  }

  async function runPull() {
    setPull({ busy: true, done: 0, total: 0 });
    try {
      const summary = await pullWayfairItemGroups({
        apply: true,
        onProgress: (done, total) => setPull({ busy: true, done, total }),
      });
      setPull({ busy: false, summary });
    } catch (err) {
      setPull({ busy: false, error: err.message });
    }
  }

  async function run(validateOnly) {
    if (!sku.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await pushToWayfair(sku.trim(), {
        validateOnly,
        market,
        supplier,
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
          <div className="w-9 h-9 rounded-lg bg-[#7B189F]/15 text-[#7B189F] dark:bg-[#7B189F]/30 dark:text-[#CE93E8] flex items-center justify-center font-bold">
            W
          </div>
          <div>
            <h2 className="text-title-md text-on-surface">Wayfair</h2>
            <p className="text-body-sm text-on-surface-variant">Push marketing copy + feature bullets & images</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Sandbox
        </span>
      </div>

      <div className="px-6 py-5 space-y-3">
        <p className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">Content &amp; images</p>
        <p className="text-body-sm text-on-surface-variant">
          Enter a product SKU, then validate the payload against Wayfair (safe — nothing changes) or
          push it live. Content needs the product's Wayfair item-group id (stored on the product or
          entered below); images push by SKU.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
            <span className="text-label-md text-on-surface-variant">Supplier / storefront</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {Object.entries(TARGETS).map(([key, t]) => (
                <option key={key} value={key}>{t.label}</option>
              ))}
            </select>
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
            {busy ? <ThinkingOrb state="solving" size={20} className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
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
        {result && !result.error && <WayfairStatusCheck result={result} />}

        <div className="pt-3 border-t border-outline-variant space-y-2">
          <p className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">Spec attributes</p>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-body-sm text-on-surface-variant">
              Dimensions, gauge, basins, material, finish, warranty… (kitchen sinks only for now).
            </p>
            <button
              type="button"
              onClick={() => runAttrs(true)}
              disabled={attrsBusy || !sku.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {attrsBusy ? <ThinkingOrb state="solving" size={20} className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
              Validate
            </button>
          </div>
          {attrs?.error && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{attrs.error}</span>
            </div>
          )}
          {attrs && !attrs.error && (
            <div className="rounded-lg border border-outline-variant text-body-sm">
              <div className="px-3 py-2 border-b border-outline-variant text-on-surface">
                {attrs.updates} attributes mapped · {attrs.changedCount} would change
                {attrs.mutation?.requestId && <span className="text-on-surface-variant"> · validated (request {attrs.mutation.requestId.slice(0, 8)}…)</span>}
                {attrs.mutation?.error && <span className="text-error"> · {attrs.mutation.error}</span>}
              </div>
              {attrs.changedCount > 0 && (
                <ul className="px-3 py-2 space-y-0.5 text-on-surface-variant">
                  {Object.entries(attrs.diff).filter(([, d]) => d.changed).map(([title, d]) => (
                    <li key={title}>
                      <span className="text-on-surface">{title}</span>: {d.current?.join('; ') ?? '(empty)'} → <span className="text-primary font-semibold">{d.new}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-outline-variant space-y-2">
          <p className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">Setup</p>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-body-sm text-on-surface-variant">
              Missing item-group ids? Import them from Wayfair's catalog for every SKU (fills empty ones only).
            </p>
            <button
              type="button"
              onClick={runPull}
              disabled={pull?.busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
            >
              {pull?.busy ? <ThinkingOrb state="searching" size={20} className="w-4 h-4" /> : <DownloadCloud className="w-4 h-4" />}
              {pull?.busy && pull.total > 0 ? `Importing… ${pull.done}/${pull.total}` : 'Import item-group IDs'}
            </button>
          </div>
          {pull?.error && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{pull.error}</span>
            </div>
          )}
          {pull?.summary && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-surface-container-high text-on-surface animate-banner-in">
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary" />
              <span>
                {pull.summary.applied} IDs imported ({pull.summary.matched} matched)
                {pull.summary.errors.length > 0 && ` · ${pull.summary.errors.length} batch errors`}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function WayfairResult({ result }) {
  if (result.error) {
    return (
      <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span className="break-words">{result.error}</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm animate-banner-in">
      <ResultRow label="Content (copy + bullets)" part={result.content} okText={(c) => `${c.bullets ?? 0} bullets · ${c.requestId ? 'validated' : 'ok'}`} />
      <ResultRow label="Media (images)" part={result.media} okText={(m) => `${m.count ?? 0} images · ${m.requestId ? 'validated' : 'ok'}`} />
    </div>
  );
}

// "What did Wayfair do with my push?" — fetches statusOfUpdateRequest for each
// requestId in the last result and shows status + per-property updates.
function WayfairStatusCheck({ result }) {
  const [statuses, setStatuses] = useState(null); // [{ label, status?, updates?, error? }]
  const [busy, setBusy] = useState(false);

  const requests = [
    result?.content?.requestId && { label: 'Content', requestId: result.content.requestId },
    result?.media?.requestId && { label: 'Media', requestId: result.media.requestId },
  ].filter(Boolean);
  if (requests.length === 0) return null;

  async function check() {
    setBusy(true);
    const out = [];
    for (const r of requests) {
      try {
        const s = await checkWayfairRequestStatus(r.requestId);
        out.push({ label: r.label, ...s });
      } catch (err) {
        out.push({ label: r.label, error: err.message });
      }
    }
    setStatuses(out);
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={check}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
      >
        {busy ? <ThinkingOrb state="searching" size={20} className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
        Check status at Wayfair
      </button>
      {statuses && (
        <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm animate-banner-in">
          {statuses.map((s) => (
            <div key={s.label} className="px-3 py-2">
              {s.error ? (
                <span className="text-error">{s.label}: {s.error}</span>
              ) : (
                <>
                  <span className="text-on-surface-variant">{s.label}: </span>
                  <span className={s.status === 'COMPLETED' ? 'text-primary font-semibold' : 'text-on-surface'}>
                    {s.status}
                  </span>
                  {s.validationOnly && <span className="text-on-surface-variant"> (validation-only run)</span>}
                  {(s.problems?.length ?? 0) > 0 && (
                    <ul className="mt-1 ml-4 list-disc text-error">
                      {s.problems.map((p, i) => (
                        <li key={i}>
                          {p.title || p.code}
                          {p.catalogEntityProperty && ` · ${p.catalogEntityProperty}`}
                          {p.detail && ` — ${p.detail}`}
                          {p.inputValue && ` (value: ${p.inputValue.length > 80 ? p.inputValue.slice(0, 80) + '…' : p.inputValue})`}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(s.successfulUpdates?.length ?? 0) > 0 && (
                    <ul className="mt-1 ml-4 list-disc text-on-surface-variant">
                      {Object.entries(
                        s.successfulUpdates.reduce((acc, u) => {
                          const key = `${u.catalogEntityProperty} → ${u.entityIdentifier}`;
                          acc[key] = (acc[key] ?? 0) + 1;
                          return acc;
                        }, {}),
                      ).map(([key, n]) => (
                        <li key={key}>{n > 1 ? `${n} × ${key}` : key}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
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
