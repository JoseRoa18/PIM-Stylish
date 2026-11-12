import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { startTask } from '@/lib/taskProgress';
import { getThumbnailUrl, thumbFallback } from '@/features/media/api/media';
import { checkBestBuyListings, createBestBuyOffer, loadBestBuyContent, setBestBuyOfferWanted } from '../api/bestbuySync';
import { BB_CATEGORY_OPTIONS } from '../lib/bestbuyContent';

const money = (n) => (n == null ? '—' : `C$${Number(n).toFixed(2)}`);
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const productUrl = (id) => `https://www.bestbuy.ca/en-ca/product/${id}`;

// A product's Best Buy Canada. With an offer: the offer as Best Buy has it, and
// every field its "Push Best Buy" would send. Without one: where it stands, the
// product its push would create, and its offer, which goes with a person's click
// (user, 2026-11-06: "yo elijo qué oferta crear"): the button once Best Buy has the
// product, or the box that asks for it with the product, so it goes when approved.
// Opening it sends Best Buy nothing.
export default function BestBuyProductCard({ sku, onPlan }) {
  const { canEdit } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [category, setCategory] = useState(null);
  const [withOffer, setWithOffer] = useState(true);

  const load = useCallback(async () => {
    try {
      let d = await loadBestBuyContent(sku, { category });
      // How Best Buy answered since the last look.
      if (canEdit && ['in_review', 'offer_sent'].includes(d.listing?.status)) {
        await checkBestBuyListings(sku);
        d = await loadBestBuyContent(sku, { category });
      }
      setError(null);
      setData(d);
    } catch (err) {
      setError(err.message ?? String(err));
      onPlan?.(null);
    }
  }, [sku, category, canEdit, onPlan]);

  useEffect(() => { load(); }, [load]);

  // What the push bar above goes by.
  useEffect(() => {
    if (!data) return;
    onPlan?.({
      offer: data.offer ?? null,
      catalog: data.catalog ?? null,
      mismatch: Boolean(data.mismatch),
      listing: data.listing ?? null,
      category: data.category ?? null,
      plan: data.plan ?? null,
      withOffer,
      problems: data.built?.problems ?? [],
    });
  }, [data, withOffer, onPlan]);

  if (error && !data) {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <p role="alert" className="text-body-sm text-error">{error}</p>
        <button type="button" onClick={load} className="px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Try again</button>
      </div>
    );
  }
  if (!data) {
    return (
      <p role="status" className="text-body-sm text-on-surface-variant inline-flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Reading Best Buy…
      </p>
    );
  }
  if (!data.offer) {
    return <NotListed sku={sku} data={data} canEdit={canEdit} category={data.category} onCategory={setCategory} withOffer={withOffer} onWithOffer={setWithOffer} onChanged={load} />;
  }

  const { offer, built } = data;
  const discounted = offer.discount_price != null && offer.discount_price < offer.price;
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-title-md text-on-surface">On Best Buy Canada</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">{offer.product_title ?? 'No title on the offer'}</p>
          </div>
          {offer.bb_product_id && <OpenPage id={offer.bb_product_id} />}
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-body-sm">
          <Fact label="State" value={offer.active ? 'Active' : 'Inactive'} />
          <Fact label="Stock" value={offer.quantity ?? '—'} />
          <Fact label="Price" value={discounted ? `${money(offer.discount_price)} (regular ${money(offer.price)})` : money(offer.price)} />
          <Fact label="Category" value={offer.category_label ?? offer.category_code ?? '—'} />
        </dl>
      </header>
      <div className="px-6 py-5 space-y-4">
        <Content built={built} title="What a push sends" intro="The PIM's values, in the fields Best Buy asks for in this category. Best Buy reviews them before they show." />
      </div>
    </section>
  );
}

function NotListed({ sku, data, canEdit, category, onCategory, withOffer, onWithOffer, onChanged }) {
  const { catalog, mismatch, plan, listing, built } = data;
  const status = listing?.status;
  const reviewing = status === 'in_review';
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-title-md text-on-surface">Not on Best Buy Canada yet</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              It takes the product in Best Buy&apos;s catalog (its review approves it) and an offer on it. Best Buy takes no offer until it has the product.
            </p>
          </div>
          {catalog?.bb_product_id && <OpenPage id={catalog.bb_product_id} />}
        </div>
      </header>
      <div className="px-6 py-5 space-y-5">
        <ListingStatus listing={listing} />
        {mismatch ? (
          <p role="alert" className="text-body-sm text-error">
            Best Buy has the UPC {plan.upc} as another product: &quot;{catalog.title}&quot;. Nothing can go until the UPC is sorted out.
          </p>
        ) : catalog ? (
          <>
            <p className="text-body-sm text-on-surface">
              Best Buy already has this product: <span className="font-medium">{catalog.title}</span>
              {catalog.category_label ? ` (${catalog.category_label})` : ''}. Only the offer is missing. Once it is live, Push updates the content.
            </p>
            {status !== 'offer_sent' && <OfferButton sku={sku} plan={plan} canEdit={canEdit} onChanged={onChanged} />}
          </>
        ) : (
          <>
            {reviewing ? (
              <WantOffer sku={sku} plan={plan} listing={listing} canEdit={canEdit} onChanged={onChanged} />
            ) : (
              <>
                <div>
                  <label htmlFor="bb-category" className="block text-label-md text-on-surface-variant mb-1">Best Buy category</label>
                  <select
                    id="bb-category"
                    value={category}
                    disabled={!canEdit}
                    onChange={(e) => onCategory(e.target.value)}
                    className="w-full max-w-md px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-sm text-on-surface"
                  >
                    {BB_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                {canEdit && (
                  <OfferBox id="bb-with-offer" checked={withOffer && !plan.problems.length} disabled={plan.problems.length > 0} plan={plan} onChange={onWithOffer} />
                )}
              </>
            )}
            <Content built={built} title={reviewing ? 'What the product carries' : 'What a push creates'} intro="The product, for Best Buy's review." />
          </>
        )}
      </div>
    </section>
  );
}

function OfferBox({ id, checked, disabled, plan, onChange }) {
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 w-4 h-4 accent-primary" />
      <label htmlFor={id} className="text-body-sm text-on-surface">
        Also create its offer once Best Buy approves the product: {money(plan.price)} (MAP Blue), warranty {plan.warrantyDays}.
        {plan.problems.length > 0 && <span className="block text-on-surface-variant">The PIM lacks: {plan.problems.join('; ')}.</span>}
      </label>
    </div>
  );
}

/** A product already in review: ask for its offer, or stop asking. */
function WantOffer({ sku, plan, listing, canEdit, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  if (!canEdit) return null;
  async function change(want) {
    setBusy(true);
    setMessage(null);
    try {
      await setBestBuyOfferWanted(sku, want);
      await onChanged();
    } catch (err) {
      setMessage(err.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <OfferBox id="bb-want-offer" checked={Boolean(listing.offer_wanted)} disabled={busy || plan.problems.length > 0} plan={plan} onChange={change} />
      {message && <p role="alert" className="text-body-sm text-error">{message}</p>}
    </div>
  );
}

const STATUS_TEXT = {
  in_review: (l) => `In Best Buy's review since ${when(l.requested_at)} (import ${l.content_import_id}).${l.offer_wanted ? ' Its offer goes once approved: the PIM looks every hour.' : ''}`,
  approved: (l) => (l.note ? l.note : 'Best Buy approved the product. Its offer is yours to create.'),
  offer_sent: (l) => `Offer sent on ${when(l.offer_sent_at)} (import ${l.offer_import_id}). Waiting for Best Buy to show it. Stock sync gives it its stock with the next Canada file.`,
  live: (l) => `Offer live since ${when(l.live_at)}. It joins this page with the next pull of offers.`,
};
function ListingStatus({ listing }) {
  if (!listing) return null;
  if (listing.status === 'refused' || listing.status === 'failed') {
    return (
      <div role="alert" className="text-body-sm text-error whitespace-pre-line">
        {listing.status === 'refused' ? 'Best Buy refused the product' : 'Best Buy refused the offer'}: {listing.note ?? 'no reason given'}. Fix it and send it again.
      </div>
    );
  }
  const text = STATUS_TEXT[listing.status]?.(listing);
  return text ? <p role="status" className="text-body-sm text-on-surface rounded-lg bg-surface-container px-3 py-2">{text}</p> : null;
}

/** The offer now: the only two things filled are MAP Blue and warranty 0. */
function OfferButton({ sku, plan, canEdit, onChanged }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function create() {
    const ok = await confirm({
      title: `Create the offer of ${sku} on Best Buy?`,
      message: `Price ${money(plan.price)} (MAP Blue), warranty ${plan.warrantyDays}. Nothing else is filled: it starts at 0 units and Stock sync gives it its stock with the next Canada file.`,
      confirmLabel: 'Create offer',
    });
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    const task = startTask(`Best Buy offer · ${sku}`, { detail: 'Sending the offer…' });
    try {
      const r = await createBestBuyOffer(sku);
      task.finish(`Offer sent (import ${r.importId})`);
      await onChanged();
    } catch (err) {
      task.fail(err);
      setMessage(err.message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant p-4 space-y-3">
      <h3 className="text-title-md text-on-surface font-medium">Its offer</h3>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-body-sm">
        <Fact label="Price (MAP Blue)" value={money(plan.price)} />
        <Fact label="Warranty - Parts & Labour" value={plan.warrantyDays} />
      </dl>
      {plan.problems.length > 0 && <p className="text-body-sm text-on-surface-variant">The PIM lacks: {plan.problems.join('; ')}.</p>}
      {message && <p role="alert" className="text-body-sm text-error">{message}</p>}
      {canEdit && (
        <button
          type="button"
          onClick={create}
          disabled={busy || plan.problems.length > 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
          Create offer
        </button>
      )}
    </div>
  );
}

function Content({ built, title, intro }) {
  if (!built) return null;
  if (built.problems.length > 0) {
    return <div role="alert" className="text-body-sm text-error">It can&apos;t go to Best Buy yet: {built.problems.join('; ')}.</div>;
  }
  return (
    <>
      <div>
        <h3 className="text-title-md text-on-surface font-medium">{title}</h3>
        <p className="text-body-sm text-on-surface-variant mt-0.5">{intro}</p>
      </div>
      <dl className="divide-y divide-outline-variant/50 border-y border-outline-variant/50">
        {built.fields.map((f) => (
          <div key={f.key} className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-x-4 py-2">
            <dt className="text-label-md text-on-surface-variant">
              {f.label}
              {f.required && <span className="sr-only"> (required)</span>}
              {f.required && <span aria-hidden className="text-error"> *</span>}
            </dt>
            <dd className="text-body-sm text-on-surface break-words min-w-0">{f.value}</dd>
          </div>
        ))}
        <div className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-x-4 py-2">
          <dt className="text-label-md text-on-surface-variant">Images ({built.images.length})</dt>
          <dd className="flex flex-wrap gap-2 min-w-0">
            {built.images.map((url, i) => (
              <img
                key={url}
                src={getThumbnailUrl(url, 200)}
                onError={thumbFallback(url)}
                alt={i === 0 ? 'Main image' : `Image ${i + 1}`}
                loading="lazy"
                className="w-14 h-14 rounded-lg object-cover border border-outline-variant bg-surface-container-low"
              />
            ))}
          </dd>
        </div>
      </dl>
      {built.notes.length > 0 && (
        <ul className="text-body-sm text-on-surface space-y-1">
          {built.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {built.leftOut.length > 0 && (
        <p className="text-body-sm text-on-surface-variant">
          Left out, the PIM has no value for it (Best Buy keeps what it has): {built.leftOut.join(', ')}.
        </p>
      )}
    </>
  );
}

function OpenPage({ id }) {
  return (
    <a href={productUrl(id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-md text-primary hover:underline flex-shrink-0">
      <ExternalLink className="w-3.5 h-3.5" aria-hidden />
      Open the page
    </a>
  );
}

function Fact({ label, value }) {
  return (
    <div className="inline-flex gap-1.5">
      <dt className="text-on-surface-variant">{label}:</dt>
      <dd className="text-on-surface">{value}</dd>
    </div>
  );
}
