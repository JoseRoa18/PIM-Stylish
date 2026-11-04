import { useId, useState } from 'react';
import { AlertTriangle, Loader2, UploadCloud } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { startTask } from '@/lib/taskProgress';
import { WIX_SITES } from '../lib/wixSites';

// "Push <store>" on every marketplace card of the product page (user,
// 2026-11-04): one button that sends everything the PIM has to that store,
// as the PIM recommends it — after the person ticks that they accept it
// ("se acepta que se suba todo tal cual como PIM lo recomienda"). What each
// store takes differs; a store that takes nothing (or not yet) says why.

function planFor(channel, product, linked) {
  const sku = product.sku;
  if (WIX_SITES[channel]) {
    const label = WIX_SITES[channel].label;
    // The PIM writes the WHERE TO BUY of the Stylish pages and the Azuni store's.
    const wtb = ['stylish_ca', 'stylish_us', 'azuni_ca'].includes(channel);
    return {
      label,
      travels: [
        'The description, auto-formatted in the house style',
        'Prices and weight',
        'Dimensions and features',
        'The documents section: only the documents the PIM has',
        ...(wtb ? ['The WHERE TO BUY links the PIM keeps — only the working ones'] : []),
        "The whole image gallery, in the PIM's order",
        ...(linked === false ? ['Not on this store yet: it is created first, hidden — show it from the card below when ready'] : []),
      ],
      never: ['The product name', ...(wtb ? [] : ["The WHERE TO BUY section — it stays as the store has it"])],
      run: async ({ task }) => {
        const { pushProductToWixSite } = await import('../api/wixSync');
        const r = await pushProductToWixSite(sku, channel, { task });
        if (!r.ok) throw new Error(r.error ?? 'The push failed.');
        const media = String(r.media ?? '');
        const wtb = r.whereToBuy ? ` · Where to Buy ${r.whereToBuy}` : '';
        return `${r.created ? 'Created (hidden) and pushed' : 'Pushed'} · images ${media.startsWith('ok') ? media.replace(/^ok\s*/, '') : media.replace(/^(warning|failed):\s*/, '')}${wtb}`;
      },
    };
  }
  if (channel === 'wayfair_ca' || channel === 'wayfair_us') {
    const usa = channel === 'wayfair_us';
    const label = usa ? 'Wayfair USA' : 'Wayfair Canada';
    return {
      label,
      travels: ['The spec attributes (sizes, materials, features…)', 'Images, videos and documents'],
      never: ["Title, description, bullets and prices — Wayfair's API does not take them"],
      disabled: linked ? null : usa
        ? 'Not on Wayfair USA yet — Wayfair copies new listings from Wayfair Canada.'
        : 'Not on Wayfair Canada yet — list it with the new-listing card below first.',
      run: async ({ task }) => {
        const { pushEverythingToWayfair } = await import('../api/wayfairSync');
        const r = await pushEverythingToWayfair(sku, { supplier: usa ? 'USA' : 'CAN', market: usa ? 'US' : 'CA', task });
        const refused = [r.specs?.ok ? null : `specs (${r.specs?.error})`, ...r.media.filter((m) => m.error).map((m) => m.step)].filter(Boolean);
        const sent = r.media.filter((m) => !m.error).map((m) => `${m.count} ${m.step}`);
        if (!r.specs?.ok && !sent.length) throw new Error(`Wayfair refused it: ${refused.join(', ')}`);
        return `Sent to Wayfair${r.specs?.ok ? ' · specs' : ''}${sent.length ? ` · ${sent.join(', ')}` : ''}${refused.length ? ` · refused: ${refused.join(', ')}` : ''} — "Review push…" shows what Wayfair did`;
      },
    };
  }
  if (channel === 'walmart_us') {
    return {
      label: 'Walmart USA',
      travels: ['An offer on the listing Walmart already has for this UPC: SKU, UPC, price (MAP Blue USD), shipping weight and condition'],
      never: ["The content — Walmart keeps its own until the brand is approved on Walmart's Brand Portal"],
      disabled: linked == null
        ? 'Checking Walmart…'
        : linked ? "Already on Walmart USA. The PIM's content goes once the brand is approved on Walmart's Brand Portal." : null,
      run: async () => {
        const { submitWalmartItems } = await import('../api/walmartAdd');
        const r = await submitWalmartItems([sku], { sandbox: false, confirm: 'CREATE', setup: 'match' });
        if (!r?.feedId) throw new Error(r?.error ?? 'Walmart did not take the feed.');
        return `Sent to Walmart (feed ${r.feedId}) — its answer shows in the card below within the hour`;
      },
    };
  }
  if (channel === 'walmart_ca') {
    return {
      label: 'Walmart Canada',
      travels: [],
      never: [],
      disabled: "Walmart Canada takes no product content through its API — nothing can be pushed from the PIM.",
    };
  }
  return null;
}

export default function ChannelPushBar({ channel, product, linked, onPushed }) {
  const plan = planFor(channel, product, linked);
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState(null); // null | 'busy' | { ok, text }
  if (!plan) return null;

  async function run() {
    setAsking(false);
    setState('busy');
    const task = startTask(`Push to ${plan.label}`, { detail: product.sku });
    try {
      const text = await plan.run({ task });
      task.finish(text);
      setState({ ok: true, text });
      onPushed?.();
    } catch (err) {
      task.fail(err);
      setState({ ok: false, text: err.message });
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <p className="text-title-md text-on-surface">Push to {plan.label}</p>
        <p className="text-body-sm text-on-surface-variant mt-0.5">
          {plan.disabled ?? `Everything ${plan.label} takes, exactly as the PIM has it and recommends it.`}
        </p>
        {state && state !== 'busy' && (
          <p role={state.ok ? 'status' : 'alert'} className={`text-body-sm mt-1 ${state.ok ? 'text-on-surface' : 'text-error'}`}>{state.text}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={Boolean(plan.disabled) || state === 'busy'}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {state === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <UploadCloud className="w-4 h-4" aria-hidden />}
        Push {plan.label}
      </button>
      {asking && <PushConfirmDialog plan={plan} sku={product.sku} onCancel={() => setAsking(false)} onConfirm={run} />}
    </section>
  );
}

function PushConfirmDialog({ plan, sku, onCancel, onConfirm }) {
  const [accepted, setAccepted] = useState(false);
  const acceptId = useId();
  return (
    <Dialog
      onClose={onCancel}
      title={`Push ${sku} to ${plan.label}?`}
      subtitle="It goes up exactly as the PIM has it and recommends it; what the store shows now is replaced."
      maxWidth="max-w-lg"
      footer={(
        <>
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!accepted} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            <UploadCloud className="w-4 h-4" aria-hidden />
            Push {plan.label}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        <div role="note" className="rounded-xl bg-warning-container text-on-warning-container px-4 py-3 flex items-start gap-2 text-body-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
          <p>By pushing, you accept that {sku} goes up to {plan.label} exactly as the PIM has it and recommends it. Nothing is reviewed first.</p>
        </div>
        <div>
          <h3 className="text-label-md text-on-surface mb-1">What goes up</h3>
          <ul className="list-disc pl-5 space-y-0.5 text-body-sm text-on-surface">
            {plan.travels.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
        {plan.never.length > 0 && (
          <div>
            <h3 className="text-label-md text-on-surface mb-1">What never goes</h3>
            <ul className="list-disc pl-5 space-y-0.5 text-body-sm text-on-surface-variant">
              {plan.never.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        )}
        <label htmlFor={acceptId} className="flex items-start gap-2 text-body-md text-on-surface cursor-pointer">
          <input id={acceptId} type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1 w-4 h-4 accent-primary" />
          I accept that it goes up as the PIM recommends it
        </label>
      </div>
    </Dialog>
  );
}
