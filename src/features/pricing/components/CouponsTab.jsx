import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, Loader2, Plus, Square, Tag, Trash2, Upload, X } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import FileDropzone from '@/components/ui/FileDropzone';
import DealsOverview from '@/features/pricing/components/DealsOverview';
import { createCoupons, deleteCoupon, endCoupon, getCouponProducts, listCoupons, reviewCoupons } from '@/features/pricing/api/coupons';
import { parsePriceList, parseSkuList } from '@/features/pricing/api/promotions';
import { COUPON_MARKETPLACES, couponAmountText, couponDiscountText, couponProblem, downloadCouponTemplate, parseCouponFile, parseCouponValue } from '@/features/pricing/lib/couponTemplate';
import { etToday } from '@/features/pricing/lib/promoCalendar';
import { startTask } from '@/lib/taskProgress';

const input = 'mt-1 w-full px-3 py-2 rounded-lg bg-surface-container-low border border-outline-variant text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40';
const actionCls = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50';
const label = (key) => COUPON_MARKETPLACES.find((c) => c.key === key)?.label ?? key;
const fmtDay = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listOf = (skus, max = 10) => `${skus.slice(0, max).join(', ')}${skus.length > max ? ` and ${skus.length - max} more` : ''}`;

function stateOf(c, today) {
  if (c.ended_at || c.ends_on < today) return { word: 'Ended', cls: 'bg-surface-container-high text-on-surface-variant' };
  if (c.starts_on > today) return { word: 'Scheduled', cls: 'bg-surface-container text-on-surface-variant' };
  return { word: 'Running', cls: 'bg-success-container text-on-success-container' };
}

// What the form could not put on a coupon, said after it is created.
function leftOutNote(reviewed) {
  const notes = [];
  const missing = [...new Set(reviewed.flatMap((c) => c.notInPim))];
  if (missing.length) notes.push(`Not in the PIM, left out: ${listOf(missing)}`);
  for (const c of reviewed) {
    if (c.exists) notes.push(`${label(c.marketplace)}: it already existed, not created again`);
    else if (c.excluded.length) notes.push(`${label(c.marketplace)}: switched off, left out: ${listOf(c.excluded)}`);
  }
  return notes.join(' · ') || null;
}

/** Coupons on Amazon and Wayfair: several can run at once. */
export default function CouponsTab({ canEdit, confirm }) {
  const [coupons, setCoupons] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [openId, setOpenId] = useState(null);

  async function reload() {
    try {
      setCoupons(await listCoupons());
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    let active = true;
    listCoupons().then((list) => { if (active) setCoupons(list); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  // The overview's shape: a coupon runs by its dates, on its one marketplace.
  const deals = useMemo(() => (coupons ?? []).map((c) => ({
    ...c,
    period: `${c.starts_on.slice(0, 7)}-01`,
    marketplaces: [c.marketplace],
    status: c.ended_at ? 'ended' : 'active',
  })), [coupons]);

  function open(id) {
    setOpenId(id);
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById(`coupon-card-${id}`)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    }));
  }

  return (
    <>
      {error && <div role="alert" className="rounded-xl bg-error-container/60 text-on-error-container px-4 py-3 text-body-sm">{error}</div>}
      {canEdit && (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => setShowNew((v) => !v)} aria-expanded={showNew} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" aria-hidden="true" />
            New coupon
          </button>
          <button type="button" onClick={() => setShowUpload(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-outline-variant text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors">
            <Upload className="w-4 h-4" aria-hidden="true" />
            Upload template
          </button>
        </div>
      )}
      {notice && <p role="status" className="text-body-sm text-on-surface bg-tertiary-container/40 rounded-lg px-3 py-2">{notice}</p>}
      {showNew && <NewCouponForm onClose={() => setShowNew(false)} onCreated={(note) => { setShowNew(false); setNotice(note); reload(); }} />}
      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} onCreated={() => { setShowUpload(false); reload(); }} />}

      {coupons === null && !error ? (
        <div className="rounded-2xl bg-surface p-8 text-center text-on-surface-variant text-body-md">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2 align-middle" aria-hidden="true" />
          Loading coupons…
        </div>
      ) : coupons?.length === 0 && !showNew ? (
        <div className="rounded-2xl bg-surface px-6 py-12 text-center">
          <div className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-surface-container mb-3">
            <Tag className="w-6 h-6 text-on-surface-variant" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <p className="text-title-md text-on-surface font-medium">No coupons yet</p>
          <p className="text-body-md text-on-surface-variant mt-1 max-w-md mx-auto">Create one here, or upload the template with several at once.</p>
        </div>
      ) : coupons?.length > 0 && (
        <div className="space-y-3">
          <DealsOverview kind="coupon" promotions={deals} onOpen={open} />
          {coupons.map((c) => (
            <CouponCard key={c.id} coupon={c} canEdit={canEdit} confirm={confirm} open={openId === c.id} onToggle={() => setOpenId((cur) => (cur === c.id ? null : c.id))} onChanged={reload} />
          ))}
        </div>
      )}
    </>
  );
}

function CouponCard({ coupon, canEdit, confirm, open, onToggle, onChanged }) {
  const today = etToday();
  const state = stateOf(coupon, today);
  const over = state.word === 'Ended';
  const [products, setProducts] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || products) return undefined;
    let active = true;
    getCouponProducts(coupon.id).then((list) => { if (active) setProducts(list); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [open, products, coupon.id]);

  async function act(kind, fn, confirmOptions) {
    if (!(await confirm(confirmOptions))) return;
    setBusy(kind);
    setError(null);
    try {
      await fn(coupon);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id={`coupon-card-${coupon.id}`} className="rounded-2xl bg-surface border border-outline-variant scroll-mt-28">
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left">
        <span className="min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-title-md text-on-surface font-semibold">{coupon.name}</span>
            <span className={`px-2 py-0.5 rounded-full text-label-md font-semibold whitespace-nowrap ${state.cls}`}>{state.word}</span>
            <span className="px-2 py-0.5 rounded-full text-label-sm bg-surface-container text-on-surface whitespace-nowrap">{label(coupon.marketplace)}</span>
          </span>
          <span className="block mt-0.5 text-body-sm text-on-surface-variant tabular-nums">
            {couponDiscountText(coupon)} · {fmtDay(coupon.starts_on)} to {fmtDay(coupon.ends_on)} · {plural(coupon.sku_count, 'product')}
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-on-surface-variant transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="border-t border-outline-variant/60" />
          {products === null && !error ? (
            <p className="text-body-sm text-on-surface-variant">Loading its products…</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" aria-label={`Products of ${coupon.name}`}>
              {(products ?? []).map((p) => (
                <li key={p.sku} className="px-2 py-0.5 rounded-full bg-surface-container text-label-md text-on-surface">
                  <span className="font-mono">{p.sku}</span>
                  {p.discount_amount != null && <span className="ml-1.5 font-semibold tabular-nums">{couponAmountText(coupon.marketplace, p.discount_amount)}</span>}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="flex items-center gap-2 flex-wrap">
              {!over && (
                <button type="button" className={actionCls} disabled={busy != null} aria-busy={busy === 'end'} onClick={() => act('end', endCoupon, { title: `End "${coupon.name}" now?`, message: 'It stops counting as running in the PIM. Stop it on the marketplace too.', confirmLabel: 'End coupon' })}>
                  {busy === 'end' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Square className="w-3.5 h-3.5" aria-hidden="true" />}
                  End now
                </button>
              )}
              <button type="button" className={actionCls} disabled={busy != null} aria-busy={busy === 'delete'} onClick={() => act('delete', deleteCoupon, { title: `Delete "${coupon.name}"?`, message: 'Removes the coupon and its product list from the PIM.', confirmLabel: 'Delete', destructive: true })}>
                {busy === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
                Delete
              </button>
            </div>
          )}
          {error && <p role="alert" className="text-body-sm text-error">{error}</p>}
        </div>
      )}
    </section>
  );
}

function NewCouponForm({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [marketplaces, setMarketplaces] = useState([]); // one coupon per marketplace: each portal has its own
  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // A percentage is the whole coupon's; money is per product (user, 2026-11-09).
  const money = type === 'amount';
  const currency = [...new Set(marketplaces.map((k) => (k.endsWith('_ca') ? 'CAD' : 'USD')))].sort().join(' / ') || 'money';
  const list = useMemo(() => {
    if (!money) return parseSkuList(text);
    const { rows, skipped } = parsePriceList(text);
    const amounts = Object.fromEntries(rows.map((r) => [r.sku.toUpperCase(), r.price]));
    return { skus: Object.keys(amounts), amounts, skipped };
  }, [text, money]);

  async function create() {
    setBusy(true);
    setError(null);
    let task = null;
    try {
      const base = { name: name.trim(), discount_type: type, discount_value: money ? null : parseCouponValue(value, type), amounts: money ? list.amounts : null, starts_on: startsOn, ends_on: endsOn, skus: list.skus };
      const problem = couponProblem({ ...base, marketplace: marketplaces[0] ?? null });
      if (problem) throw new Error(problem);
      if (money && list.skipped.length) throw new Error(`These lines need a SKU and an amount: ${listOf(list.skipped, 5)}`);
      task = startTask(marketplaces.length > 1 ? 'Create coupons' : 'Create coupon', { detail: 'Checking the products…' });
      const reviewed = await reviewCoupons(marketplaces.map((marketplace) => ({ ...base, marketplace })));
      if (reviewed.every((c) => c.exists)) throw new Error('A coupon with that name and first day already exists on the marketplaces picked.');
      if (!reviewed.some((c) => c.skus.length && !c.exists)) throw new Error('None of these products can go on this coupon: they are not in the PIM or are switched off for the marketplaces picked.');
      const made = await createCoupons(reviewed, { task: task.part(0.3, 1) });
      task.finish(plural(made, 'coupon'));
      onCreated(leftOutNote(reviewed));
    } catch (err) {
      task?.fail(err);
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-surface p-6 space-y-4 border border-outline-variant">
      <div className="flex items-center justify-between">
        <h2 className="text-title-md text-on-surface font-semibold">New coupon</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-full hover:bg-surface-container text-on-surface-variant">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-label-lg text-on-surface-variant">Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <div className="grid grid-cols-2 gap-2 min-w-0">
          <label className="block min-w-0">
            <span className="text-label-lg text-on-surface-variant">Start day</span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={input} />
          </label>
          <label className="block min-w-0">
            <span className="text-label-lg text-on-surface-variant">End day</span>
            <input type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} className={input} />
          </label>
        </div>
      </div>
      <div>
        <span className="text-label-lg text-on-surface-variant">Marketplaces</span>
        <p className="text-body-sm text-on-surface-variant mt-0.5">Pick one or several. Each one gets its own coupon, with the same discount, dates and products.</p>
        <div className="mt-2 flex items-center gap-1.5 flex-wrap" role="group" aria-label="Marketplaces">
          {COUPON_MARKETPLACES.map((c) => {
            const on = marketplaces.includes(c.key);
            return (
              <button key={c.key} type="button" aria-pressed={on} onClick={() => setMarketplaces(on ? marketplaces.filter((k) => k !== c.key) : [...marketplaces, c.key])} className={`px-3 py-1 rounded-full text-label-md border transition-colors ${on ? 'bg-primary text-on-primary border-primary' : 'bg-surface border-outline-variant text-on-surface hover:bg-surface-container-low'}`}>
                {c.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-end gap-4 flex-wrap">
        <div className="inline-flex rounded-lg bg-surface-container p-1" role="group" aria-label="Discount type">
          {[['percent', 'Percentage'], ['amount', 'Money']].map(([key, text2]) => (
            <button key={key} type="button" aria-pressed={type === key} onClick={() => setType(key)} className={`px-3 py-1.5 rounded-md text-label-lg font-medium transition-colors ${type === key ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}>
              {text2}
            </button>
          ))}
        </div>
        {money ? (
          <p className="text-body-sm text-on-surface-variant pb-2">Each product has its own amount: type it next to its SKU below.</p>
        ) : (
          <label className="block w-44">
            <span className="text-label-md text-on-surface-variant">Discount (%), for the whole coupon</span>
            <input type="number" min="0" max="99" step="any" value={value} onChange={(e) => setValue(e.target.value)} className={input} />
          </label>
        )}
      </div>
      <label className="block">
        <span className="text-label-lg text-on-surface-variant">{money ? `Products: SKU and amount (${currency}), one per line` : 'Products: one SKU per line'}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={money ? 'S-822H 25\nK-131NR 40\n…' : 'S-822H\nK-131NR\n…'} className={`${input} font-mono text-body-sm`} />
      </label>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-body-sm text-on-surface-variant">{plural(list.skus.length, 'SKU')}{list.skipped.length > 0 ? ` · ${plural(list.skipped.length, 'line')} skipped` : ''}</p>
        <button type="button" onClick={create} disabled={busy} aria-busy={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
          Create coupon
        </button>
      </div>
      {error && <p role="alert" className="text-body-sm text-on-error-container bg-error-container/60 rounded-lg px-3 py-2">{error}</p>}
    </div>
  );
}

function UploadDialog({ onClose, onCreated }) {
  const [plan, setPlan] = useState(null); // { fileName, coupons (reviewed), errors, examples }
  const [busy, setBusy] = useState(null); // 'read' | 'create' | 'template'
  const [error, setError] = useState(null);
  const ready = (plan?.coupons ?? []).filter((c) => c.skus.length && !c.exists);
  const canCreate = plan && !plan.errors.length && ready.length > 0;

  async function template() {
    setBusy('template');
    setError(null);
    try {
      await downloadCouponTemplate();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function read(file) {
    setBusy('read');
    setError(null);
    setPlan(null);
    try {
      const parsed = await parseCouponFile(file);
      setPlan({ fileName: file.name, ...parsed, coupons: parsed.coupons.length ? await reviewCoupons(parsed.coupons) : [] });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    setBusy('create');
    setError(null);
    const task = startTask('Upload coupons', { detail: 'Creating the coupons…' });
    try {
      const made = await createCoupons(plan.coupons, { task });
      task.finish(plural(made, 'coupon'));
      onCreated();
    } catch (err) {
      task.fail(err);
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title="Upload coupons"
      subtitle="One row per product. Rows with the same name and marketplace are one coupon."
      maxWidth="max-w-2xl"
      footer={(
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full text-label-lg text-on-surface-variant hover:bg-surface-container-low">Close</button>
          <button type="button" onClick={create} disabled={!canCreate || busy != null} aria-busy={busy === 'create'} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary text-label-lg hover:bg-primary/90 disabled:opacity-50">
            {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
            {ready.length ? `Create ${plural(ready.length, 'coupon')}` : 'Create coupons'}
          </button>
        </>
      )}
    >
      <div className="space-y-4">
        <button type="button" onClick={template} disabled={busy != null} aria-busy={busy === 'template'} className={actionCls}>
          {busy === 'template' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />}
          Download template
        </button>
        <FileDropzone accept=".xlsx,.csv" onFile={read} disabled={busy != null} className="block rounded-xl border border-dashed border-outline-variant px-4 py-6 text-center text-body-md text-on-surface-variant">
          {busy === 'read' ? 'Reading the file…' : plan ? `${plan.fileName}: drop another file to replace it` : 'Drop the filled template here, or click to choose it'}
        </FileDropzone>
        {plan && plan.errors.length > 0 && (
          <div role="alert" className="rounded-lg bg-error-container/60 text-on-error-container px-3 py-2 text-body-sm">
            <p className="font-medium">Fix these rows and upload the file again; nothing was created:</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              {plan.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}
            </ul>
            {plan.errors.length > 12 && <p className="mt-1">and {plan.errors.length - 12} more</p>}
          </div>
        )}
        {plan && !plan.coupons.length && !plan.errors.length && (
          <p role="status" className="text-body-sm text-on-surface-variant">The file has no coupons{plan.examples ? ', only the example rows' : ''}.</p>
        )}
        {plan?.coupons.length > 0 && (
          <ul className="rounded-xl border border-outline-variant divide-y divide-outline-variant/60">
            {plan.coupons.map((c) => (
              <li key={`${c.name}|${c.marketplace}`} className="px-3 py-2 text-body-sm">
                <p className="text-on-surface font-medium">{c.name} <span className="font-normal text-on-surface-variant">· {label(c.marketplace)} · {couponDiscountText(c)} · {fmtDay(c.starts_on)} to {fmtDay(c.ends_on)} · {plural(c.skus.length, 'product')}</span></p>
                {c.exists && <p className="text-error">Already exists: it will not be created again.</p>}
                {c.notInPim.length > 0 && <p className="text-error">Not in the PIM, left out: {listOf(c.notInPim)}</p>}
                {c.excluded.length > 0 && <p className="text-on-surface-variant">Switched off for this marketplace, left out: {listOf(c.excluded)}</p>}
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{error}</p>}
      </div>
    </Dialog>
  );
}
