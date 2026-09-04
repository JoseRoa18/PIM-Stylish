import { useState } from 'react';
import { CheckCircle2, AlertCircle, ShieldCheck, DownloadCloud, Send } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { pullWayfairItemGroups, pushWayfairAttributes } from '../api/wayfairSync';
import WayfairPushDialog from './WayfairPushDialog';

// Wayfair syndication workspace — review-then-push media for one product
// (title, description, bullets and prices never travel), validate spec
// attributes, and import item-group ids.
export default function WayfairConnectorCard() {
  const [sku, setSku] = useState('');
  const [target, setTarget] = useState('CAN_CA'); // supplier + storefront

  // One dropdown covers both supplier accounts and their storefronts.
  // Labels stay short so the select never clips its value at narrow widths.
  const TARGETS = {
    CAN_CA: { supplier: 'CAN', market: 'CA', label: 'Canada — English (CAN)' },
    CAN_CA_FR: { supplier: 'CAN', market: 'CA_FR', label: 'Canada — French (CAN)' },
    USA_US: { supplier: 'USA', market: 'US', label: 'USA (StylishUSAInc)' },
  };
  const { supplier, market } = TARGETS[target];
  const [reviewing, setReviewing] = useState(false);
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

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      {/* The page header already shows the Wayfair identity + env chip — the card starts at its content. */}
      <div className="px-6 py-5 space-y-3">
        <p className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">Push a product</p>
        <p className="text-body-sm text-on-surface-variant">
          Enter a SKU and review what would travel: spec attributes, images, videos and documents, in that order.
          Nothing is sent until you confirm. Title, description, bullets and prices never travel.
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
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setReviewing(true)}
            disabled={!sku.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
            Review push…
          </button>
        </div>
        {reviewing && (
          <WayfairPushDialog
            sku={sku.trim()}
            supplier={supplier}
            market={market === 'CA_FR' ? 'CA_FR' : market}
            label={TARGETS[target].label}
            onClose={() => setReviewing(false)}
          />
        )}

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
