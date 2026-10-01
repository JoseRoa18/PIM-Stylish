import { useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, ListChecks, ShieldCheck, PlusCircle, RefreshCw } from 'lucide-react';
import { previewWalmartItems, submitWalmartItems, walmartFeedStatus } from '../api/walmartAdd';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';

// Per-product "new listing" panel for Walmart USA, one product at a time.
// Two ways in:
//   match  an OFFER on the listing Walmart's catalog already has for the UPC
//          (most Stylish products are there from Walmart Canada, without
//          offers) — SKU, UPC, price (MAP Blue USD), shipping weight,
//          condition; Walmart keeps its content (feed MP_ITEM_MATCH)
//   item   a NEW item with the PIM's full content (feed MP_ITEM, Sinks only),
//          for a UPC Walmart doesn't have — it fails with ERR_PDI_0001 when
//          the UPC already exists
// Preview sends nothing; the real submit needs a clean preview and an explicit
// confirmation.
const SECTION_ORDER = ['Listing', 'Content', 'Media', 'Specifications', 'Compliance', 'Selling'];

export default function WalmartAdditionCard({ product }) {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null); // 'preview' | 'sandbox' | 'create' | 'status' | null
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState('match'); // 'match' | 'item'
  const match = setup === 'match';
  // Diagnostic: send only the fields Walmart's spec requires (no variant
  // group, no optional attributes) — tells a Walmart-side rejection of the
  // account (ERR_PDI_0001) from one of the optional fields. Changing it asks
  // for a new Validate, which then checks the trimmed item.
  const [onlyRequired, setOnlyRequired] = useState(false);
  const trim = onlyRequired && !match ? 'required' : undefined;
  const row = result?.products?.[0];
  const skipped = result?.skipped?.[0];
  // Submit unlocks only after a clean check: for an offer, a preview with every
  // offer field filled (Walmart publishes no schema to validate it against);
  // for a new item, a Validate against the official spec.
  const clean = match
    ? !!row && row.ready && result?.preview && result?.setup === 'match'
    : !!row && row.ready && result?.preview && result?.validation?.valid === true;
  const shownValue = (field) => row?.rows?.find((r) => r.field === field)?.value;

  function chooseSetup(next) {
    if (next === setup) return;
    setSetup(next);
    setResult(null);
    setStatus(null);
  }

  async function run(mode) {
    if (mode === 'create') {
      const ok = await confirm(match
        ? {
          title: `Add ${product.sku} as an offer on Walmart USA?`,
          message: `This adds your offer to the listing Walmart already has for ${shownValue('productIdentifiers') ?? 'this UPC'}: SKU ${product.sku}, price $${shownValue('price') ?? '—'}, shipping weight ${shownValue('ShippingWeight') ?? '—'} lb, condition New. Walmart keeps its own content on the page. It cannot be undone from the PIM.`,
          confirmLabel: 'Add offer',
        }
        : {
          title: `Create ${product.sku} on Walmart USA?`,
          message: onlyRequired
            ? 'This posts the item to the real Walmart catalog with ONLY the fields Walmart requires (no variant group, no optional attributes) — a test. If it is created, the full content goes later as an update. It cannot be undone from the PIM.'
            : 'This posts the item to the real Walmart catalog. Walmart processes it in minutes to hours; it cannot be undone from the PIM.',
          confirmLabel: 'Create listing',
        });
      if (!ok) return;
    }
    setBusy(mode);
    setResult(null);
    setStatus(null);
    try {
      const how = match ? 'match' : undefined;
      const data = mode === 'preview' || mode === 'validate'
        ? await previewWalmartItems([product.sku], { validate: mode === 'validate' && !match, trim, setup: how })
        : await submitWalmartItems([product.sku], { sandbox: mode === 'sandbox', confirm: mode === 'create' ? 'CREATE' : undefined, trim, setup: how });
      setResult(data);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!result?.feedId) return;
    setBusy('status');
    try { setStatus(await walmartFeedStatus(result.feedId, { sandbox: result.env === 'sandbox' })); }
    catch (err) { setStatus({ error: err.message }); }
    finally { setBusy(null); }
  }

  const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50';

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-walmart/10 text-brand-walmart flex items-center justify-center text-label-lg font-bold flex-shrink-0">WM</div>
          <div>
            <h2 className="text-title-lg text-on-surface leading-tight">Walmart USA · New listing</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {match
                ? 'Adds your offer to the listing Walmart already has for this UPC — most Stylish products are in its catalog from Walmart Canada. Offer fields sends nothing.'
                : 'Item setup from PIM data, for a UPC Walmart does not have. Preview and Validate send nothing; Validate checks the official Walmart spec.'}
            </p>
          </div>
        </div>
      </div>

      <div className="px-8 py-5 space-y-3">
        {canEdit && (
          <div className="inline-flex rounded-full bg-surface-container p-1" role="group" aria-label="How to list it">
            {[['match', 'Offer on existing listing'], ['item', 'New item']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => chooseSetup(key)}
                disabled={!!busy}
                aria-pressed={setup === key}
                className={`px-4 py-1.5 rounded-full text-label-md font-medium transition-colors ${setup === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => run('preview')} disabled={!!busy} className={btn} title={match ? 'The offer the PIM would send: SKU, UPC, price (MAP Blue USD), shipping weight, condition.' : "Every field the PIM maps for this product, with Walmart's field name and the value it would send."}>
              {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
              {match ? 'Offer fields' : 'Mapped fields'}
            </button>
            {!match && (
              <button type="button" onClick={() => run('validate')} disabled={!!busy} className={btn} title="Checks every field against Walmart's official item spec (the rules Walmart applies on ingestion). Nothing is sent.">
                {busy === 'validate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                Validate
              </button>
            )}
            <button
              type="button"
              onClick={() => run('create')}
              disabled={!!busy || !clean}
              title={clean ? undefined : match ? 'Check "Offer fields" first — SKU, UPC, price and shipping weight must be filled' : 'Validate first — every required field must be filled and the spec check must pass'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 transition-opacity disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed"
            >
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              {match ? 'Add offer' : 'Create listing'}
            </button>
            {result?.feedId && (
              <button type="button" onClick={refreshStatus} disabled={!!busy} className={btn}>
                {busy === 'status' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Check feed
              </button>
            )}
            {!match && (
              <label className="inline-flex items-center gap-2 ml-1 text-body-sm text-on-surface-variant cursor-pointer" title="Sends only the fields Walmart requires, to tell whether Walmart rejects the account or one of the optional fields. Validate again after changing it.">
                <input
                  type="checkbox"
                  checked={onlyRequired}
                  onChange={(e) => { setOnlyRequired(e.target.checked); setResult(null); setStatus(null); }}
                  disabled={!!busy}
                  className="accent-primary"
                />
                Required fields only (test)
              </label>
            )}
          </div>
        )}

        {result?.error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container animate-banner-in">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="break-words">{result.error}</span>
          </div>
        )}

        {skipped && !row && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-surface-container-low text-on-surface-variant">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="break-words">{skipped.reason}</span>
          </div>
        )}

        {row && (
          <div className="rounded-lg border border-outline-variant divide-y divide-outline-variant text-body-sm">
            <div className="flex items-start gap-2 px-3 py-2">
              {row.ready ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 text-error flex-shrink-0" />}
              <span className="min-w-0 break-words">
                <span className="sr-only">{row.ready ? 'Ready. ' : 'Not ready. '}</span>
                <span className="text-on-surface-variant">{result.preview ? 'preview' : result.env} · </span>
                {row.productType} · {result.trimmed ? `required fields only (${row.rows.filter((r) => r.required).length + 1} of ${row.fields})` : `${row.fields} fields`}
                {result.validation ? (result.validation.valid ? ' · spec OK' : ' · spec errors') : ''}
                {result.feedId ? ` · feed ${result.feedId}` : ''}
                {result.feedStatus ? ` · ${result.feedStatus}` : ''}
                {result.itemsFailed ? ` · ${result.itemsFailed} failed` : ''}
              </span>
            </div>
            <IssueList label="Missing in PIM (required)" items={row.missing} tone="error" />
            <IssueList label="Warnings" items={row.warnings} tone="muted" />
            <IssueList label="Walmart spec errors" items={row.specErrors?.map((e) => `${e.path || '/'}: ${e.message}`)} tone="error" />
            <IssueList label="Walmart item errors" items={(result.items ?? []).filter((it) => it.ingestionStatus !== 'SUCCESS').map((it) => `${it.sku}: ${(it.ingestionErrors?.ingestionError ?? []).map((e) => e.description).join(' · ') || it.ingestionStatus}`)} tone="error" />
            {matchError(result.items) && !status && <MatchHint product={product} />}
            <MappedTable rows={row.rows} />
          </div>
        )}

        {status && (
          <div role="status" className="rounded-lg border border-outline-variant text-body-sm px-3 py-2 space-y-1">
            {status.error ? <span className="text-error">{status.error}</span> : (
              <>
                <div>Feed {status.feedStatus ?? '—'} · received {status.itemsReceived ?? 0} · succeeded {status.itemsSucceeded ?? 0} · failed {status.itemsFailed ?? 0} · processing {status.itemsProcessing ?? 0}</div>
                {(status.items ?? []).filter((it) => it.ingestionStatus !== 'SUCCESS').map((it, i) => (
                  <div key={i} className="text-error">{it.sku}: {(it.ingestionErrors?.ingestionError ?? []).map((e) => e.description).join(' · ') || it.ingestionStatus}</div>
                ))}
                {matchError(status.items) && <MatchHint product={product} />}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ERR_PDI_0001 ("Unexpected system error occurred in item setup") is what
// Walmart answers when the UPC ALREADY EXISTS in its catalog as a listing
// without offers (S-414T, 2026-09-28: item 15229859144, likely from the
// Walmart Canada catalog). The seller API's catalog search does not return
// such listings, so the PIM can't tell beforehand — it explains it after.
const matchError = (items) =>
  (items ?? []).some((it) => (it.ingestionErrors?.ingestionError ?? []).some((e) => e.code === 'ERR_PDI_0001'));

function MatchHint({ product }) {
  const upc = product.upc || product.attributes?.upc || '';
  return (
    <div className="px-3 py-2 bg-tertiary-container/40 text-on-surface">
      <p className="font-medium">Walmart probably already has this product in its catalog</p>
      <p className="mt-0.5 text-on-surface-variant">
        A listing without offers already uses this UPC, so a new item can't be set up with it — and the API can't see that listing beforehand.
        Add your offer to it instead: choose "Offer on existing listing" above, or in Seller Center › Catalog › Add items › enter UPC {upc || '(the product UPC)'} › "We found a match" › Add item, with SKU {product.sku}.
        Once the offer exists under that SKU, the PIM's Walmart USA promotions reach it by API.
      </p>
    </div>
  );
}

function MappedTable({ rows }) {
  if (!rows?.length) return null;
  const sections = SECTION_ORDER.filter((s) => rows.some((r) => r.section === s));
  return (
    <details className="px-3 py-2">
      <summary className="cursor-pointer text-label-sm text-primary hover:underline">Show all {rows.length} mapped fields</summary>
      <div className="mt-2 space-y-3">
        {sections.map((s) => (
          <div key={s}>
            <div className="text-label-sm text-on-surface-variant mb-1">{s} · {rows.filter((r) => r.section === s).length}</div>
            <table className="w-full text-body-sm">
              <tbody className="divide-y divide-outline-variant/60">
                {rows.filter((r) => r.section === s).map((r) => (
                  <tr key={r.field} className="align-top">
                    <td className="py-1 pr-3 w-[40%] text-on-surface-variant break-words">{r.field}{r.required ? <span className="text-error"> *</span> : null}</td>
                    <td className="py-1 text-on-surface break-words">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </details>
  );
}

function IssueList({ label, items, tone }) {
  if (!items?.length) return null;
  const cls = tone === 'error' ? 'text-error' : 'text-on-surface-variant';
  return (
    <div className="px-3 py-2">
      <div className="text-label-sm text-on-surface-variant">{label}</div>
      <ul className={`mt-0.5 space-y-0.5 ${cls}`}>
        {items.map((it, i) => <li key={i} className="break-words">{it}</li>)}
      </ul>
    </div>
  );
}
