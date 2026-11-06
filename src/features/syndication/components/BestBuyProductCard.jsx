import { useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { getThumbnailUrl, thumbFallback } from '@/features/media/api/media';
import { loadBestBuyContent } from '../api/bestbuySync';

const money = (n) => (n == null ? '—' : `C$${Number(n).toFixed(2)}`);

// A product's Best Buy Canada: its offer as the latest pull read it, and every
// field its "Push Best Buy" would send (lib/bestbuyContent.js), so what goes up
// can be read before accepting it. Reads only.
export default function BestBuyProductCard({ sku }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    loadBestBuyContent(sku)
      .then((d) => { if (active) setData(d); })
      .catch((err) => { if (active) setError(err.message ?? String(err)); });
    return () => { active = false; };
  }, [sku]);

  if (error) return <p role="alert" className="text-body-sm text-error">{error}</p>;
  if (!data) {
    return (
      <p role="status" className="text-body-sm text-on-surface-variant inline-flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Reading Best Buy…
      </p>
    );
  }
  const { offer, built } = data;
  if (!offer) {
    return (
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-6">
        <h2 className="text-title-md text-on-surface">Not on Best Buy Canada</h2>
        <p className="text-body-sm text-on-surface-variant mt-1">
          The latest pull has no offer for {sku}. Only a product with an offer there can be pushed.
        </p>
      </section>
    );
  }

  const discounted = offer.discount_price != null && offer.discount_price < offer.price;
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-title-md text-on-surface">On Best Buy Canada</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">{offer.product_title ?? 'No title on the offer'}</p>
          </div>
          {offer.bb_product_id && (
            <a href={`https://www.bestbuy.ca/en-ca/product/${offer.bb_product_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-label-md text-primary hover:underline flex-shrink-0">
              <ExternalLink className="w-3.5 h-3.5" aria-hidden />
              Open the page
            </a>
          )}
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-body-sm">
          <Fact label="State" value={offer.active ? 'Active' : 'Inactive'} />
          <Fact label="Stock" value={offer.quantity ?? '—'} />
          <Fact label="Price" value={discounted ? `${money(offer.discount_price)} (regular ${money(offer.price)})` : money(offer.price)} />
          <Fact label="Category" value={offer.category_label ?? offer.category_code ?? '—'} />
        </dl>
      </header>

      <div className="px-6 py-5 space-y-4">
        {built.problems.length > 0 ? (
          <div role="alert" className="text-body-sm text-error">
            It can&apos;t go to Best Buy yet: {built.problems.join('; ')}.
          </div>
        ) : (
          <>
            <div>
              <h3 className="text-title-sm text-on-surface font-medium">What a push sends</h3>
              <p className="text-body-sm text-on-surface-variant mt-0.5">The PIM&apos;s values, in the fields Best Buy asks for in this category. Best Buy reviews them before they show.</p>
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
        )}
      </div>
    </section>
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
