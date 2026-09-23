import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Lock, Upload, Pencil, Check, X } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { loadAliases, addAlias, removeAlias, importAliasList, importAliasTitles, setAliasTitle, ALIAS_MARKETPLACES, ALIAS_KINDS } from '../api/aliases';

// Amazon USA lists products under the PIM SKU itself, so only Canada takes aliases.
const AMAZON = ['Amazon Canada'];
const inputCls = 'px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors';

/**
 * Every identifier this product has on other marketplaces: the ids the
 * PIM's own channel links hold (Wix, Wayfair, Amazon) and the aliases typed
 * or imported here for the file-based marketplaces.
 */
export default function AliasesTab({ product }) {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(null);

  async function reload() {
    try {
      setRows(await loadAliases(product));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [product.sku, product.wix_product_id, product.wayfair_item_group_id, product.wayfair_usa_item_group_id]);

  async function handleRemove(row) {
    const ok = await confirm({
      title: `Remove ${row.alias}?`,
      message: `${product.sku} will no longer be recognized as ${row.alias} on ${row.marketplace}. Files for that marketplace stop using it.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(row.id);
    try {
      await removeAlias(product.sku, row);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-title-lg text-on-surface leading-tight">Aliases</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">How {product.sku} is identified on each marketplace, and the name it is listed under there. Files and promotions use these instead of the PIM SKU and name.</p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setImporting(true)} className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">
              <Upload className="w-4 h-4" /> Import list
            </button>
            <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity">
              <Plus className="w-4 h-4" /> Add alias
            </button>
          </div>
        )}
      </header>

      <div className="px-8 py-5">
        {error && <p className="text-body-sm text-error mb-3">{error}</p>}
        {rows === null ? (
          <p className="text-body-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-body-md text-on-surface-variant">No aliases yet. Add the marketplace's item number or seller SKU, or import a list.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px]">
              <thead>
                <tr className="text-label-md text-on-surface-variant border-b border-outline-variant">
                  <th className="text-left font-medium py-2 pr-4">Marketplace</th>
                  <th className="text-left font-medium py-2 pr-4">Alias</th>
                  <th className="text-left font-medium py-2 pr-4">Type</th>
                  <th className="text-left font-medium py-2 pr-4">Name on the marketplace</th>
                  <th className="text-left font-medium py-2 pr-4">Notes</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-outline-variant/60 last:border-b-0">
                    <td className="py-2.5 pr-4 text-body-md text-on-surface whitespace-nowrap">{r.marketplace}</td>
                    <td className="py-2.5 pr-4 text-body-md text-on-surface font-mono">{r.alias}</td>
                    <td className="py-2.5 pr-4 text-body-sm text-on-surface-variant whitespace-nowrap">{r.kind}</td>
                    <td className="py-2.5 pr-4 text-body-sm text-on-surface min-w-[220px]">
                      {r.source === 'manual' ? (
                        <ListingTitleCell key={r.listingTitle ?? ''} sku={product.sku} row={r} canEdit={canEdit} onSaved={reload} onError={setError} />
                      ) : (
                        <span className="text-on-surface-variant">{r.listingTitle ?? ''}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-body-sm text-on-surface-variant">{r.note ?? ''}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {r.locked ? (
                        <span className="inline-flex items-center gap-1 text-label-sm text-on-surface-variant" title={r.note}><Lock className="w-3.5 h-3.5" /></span>
                      ) : canEdit ? (
                        <button type="button" onClick={() => handleRemove(r)} disabled={busy === r.id} className="p-1.5 rounded-full text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors disabled:opacity-50" title="Remove alias">
                          {busy === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <AddAliasDialog sku={product.sku} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload(); }} />}
      {importing && <ImportAliasesDialog onClose={() => setImporting(false)} onImported={() => { setImporting(false); reload(); }} />}
    </section>
  );
}

/** The marketplace's own product name, edited in place (Rona's "Product Description", for instance). */
function ListingTitleCell({ sku, row, canEdit, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.listingTitle ?? '');
  const [busy, setBusy] = useState(false);

  function cancel() {
    setValue(row.listingTitle ?? '');
    setEditing(false);
  }

  async function save() {
    if ((value.trim() || null) === (row.listingTitle ?? null)) { setEditing(false); return; }
    setBusy(true);
    try {
      await setAliasTitle(sku, row, value);
      setEditing(false);
      await onSaved();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') cancel(); }}
          autoFocus
          placeholder="Name as the marketplace lists it"
          className={`flex-1 min-w-[200px] py-1 ${inputCls}`}
        />
        <button type="button" onClick={save} disabled={busy} className="p-1.5 rounded-full text-primary hover:bg-primary-container/40 transition-colors disabled:opacity-50" title="Save">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        </button>
        <button type="button" onClick={cancel} disabled={busy} className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors" title="Cancel">
          <X className="w-4 h-4" />
        </button>
      </span>
    );
  }
  return (
    <span className="group inline-flex items-start gap-1.5 max-w-[420px]">
      <span className={row.listingTitle ? '' : 'text-on-surface-variant'}>{row.listingTitle ?? (canEdit ? 'Add name' : '')}</span>
      {canEdit && (
        <button type="button" onClick={() => setEditing(true)} className="p-1 rounded-full text-on-surface-variant opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-surface-container-low transition-opacity" title="Edit the name on the marketplace">
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  );
}

function AddAliasDialog({ sku, onClose, onAdded }) {
  const [marketplace, setMarketplace] = useState('Amazon Canada');
  const [alias, setAlias] = useState('');
  const [kind, setKind] = useState('sku');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const amazon = AMAZON.includes(marketplace);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addAlias(sku, { marketplace, alias, kind: amazon ? 'sku' : kind, note });
      onAdded();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} title={`Add alias to ${sku}`} subtitle="The name this product has on the marketplace." maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-label-md text-on-surface-variant">Marketplace</span>
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className={`mt-1 w-full ${inputCls}`}>
            {[...AMAZON, ...ALIAS_MARKETPLACES].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-label-md text-on-surface-variant">{amazon ? 'Seller SKU' : 'Alias'}</span>
          <input id="alias-value" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={amazon ? 'S-300XG-CAN' : '1001234567'} autoFocus className={`mt-1 w-full font-mono ${inputCls}`} />
        </label>
        {!amazon && (
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={`mt-1 w-full ${inputCls}`}>
              {ALIAS_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
        )}
        {!amazon && (
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Note (optional)</span>
            <input id="alias-note" value={note} onChange={(e) => setNote(e.target.value)} className={`mt-1 w-full ${inputCls}`} />
          </label>
        )}
        {error && <p className="text-body-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">Cancel</button>
          <button type="submit" disabled={busy || !alias.trim()} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportAliasesDialog({ onClose, onImported }) {
  const [mode, setMode] = useState('aliases'); // 'aliases' | 'names'
  const [marketplace, setMarketplace] = useState('Amazon Canada');
  const [kind, setKind] = useState('sku');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const amazon = AMAZON.includes(marketplace);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(mode === 'names' ? await importAliasTitles(marketplace, text) : await importAliasList(marketplace, text, kind));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} title={mode === 'names' ? 'Import listing names' : 'Import aliases'} subtitle={mode === 'names' ? 'One line per product: the PIM SKU, a tab, then the name the marketplace lists it under. The product needs its alias there first.' : "One line per product: the marketplace's alias, then the PIM SKU. Tab or comma between them. One alias per product."} maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-3">
        <div className="inline-flex rounded-full border border-outline-variant p-0.5">
          {[['aliases', 'Aliases'], ['names', 'Names on the marketplace']].map(([key, label]) => (
            <button key={key} type="button" onClick={() => { setMode(key); setResult(null); if (key === 'names' && AMAZON.includes(marketplace)) setMarketplace(ALIAS_MARKETPLACES[0]); }} className={`px-3.5 py-1.5 rounded-full text-label-md transition-colors ${mode === key ? 'bg-primary text-on-primary' : 'text-on-surface hover:bg-surface-container-low'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Marketplace</span>
            <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className={`mt-1 w-full ${inputCls}`}>
              {[...(mode === 'names' ? [] : AMAZON), ...ALIAS_MARKETPLACES].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {!amazon && mode !== 'names' && (
            <label className="block">
              <span className="text-label-md text-on-surface-variant">Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={`mt-1 w-full ${inputCls}`}>
                {ALIAS_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
          )}
        </div>
        <textarea
          id="alias-import-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={mode === 'names' ? 'S-300XG\tSTYLISH 28 inch Double Bowl Undermount Stainless Steel Kitchen Sink\nA-802N\tSingle Hole 9.75-inch Kitchen Faucet Plate in Matte Black' : 'S-300XG-CAN\tS-300XG\n3P-LVMJ-40J0\tA-802N'}
          className={`w-full font-mono text-body-sm ${inputCls}`}
        />
        {result && (
          <div className="text-body-sm rounded-lg px-3 py-2 bg-surface-container text-on-surface-variant space-y-1">
            <p>{result.written} {mode === 'names' ? 'names' : 'aliases'} saved.{result.notInPim.length ? ` Not in the PIM, skipped: ${result.notInPim.slice(0, 12).join(', ')}${result.notInPim.length > 12 ? ` and ${result.notInPim.length - 12} more` : ''}.` : ''}</p>
            {result.noAlias?.length > 0 && (
              <p>No {marketplace} alias yet, add it first: {result.noAlias.slice(0, 12).join(', ')}{result.noAlias.length > 12 ? ` and ${result.noAlias.length - 12} more` : ''}.</p>
            )}
            {result.review?.length > 0 && (
              <p>Several aliases for one product, pick one by hand: {result.review.slice(0, 10).map((r) => `${r.sku} (${r.aliases.join(' / ')})`).join('; ')}{result.review.length > 10 ? ` and ${result.review.length - 10} more` : ''}.</p>
            )}
            {result.conflicts?.length > 0 && (
              <p>Already have a different alias, kept as they were: {result.conflicts.slice(0, 10).map((c) => `${c.sku} (${c.current})`).join('; ')}{result.conflicts.length > 10 ? ` and ${result.conflicts.length - 10} more` : ''}.</p>
            )}
          </div>
        )}
        {error && <p className="text-body-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={result ? onImported : onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">{result ? 'Done' : 'Cancel'}</button>
          {!result && (
            <button type="submit" disabled={busy || !text.trim()} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Import
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
