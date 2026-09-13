import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Lock, Upload } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { loadAliases, addAlias, removeAlias, importAliasList, ALIAS_MARKETPLACES, ALIAS_KINDS } from '../api/aliases';

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
          <p className="text-body-sm text-on-surface-variant mt-0.5">How {product.sku} is identified on each marketplace. Files and promotions use these instead of the PIM SKU.</p>
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
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="text-label-md text-on-surface-variant border-b border-outline-variant">
                  <th className="text-left font-medium py-2 pr-4">Marketplace</th>
                  <th className="text-left font-medium py-2 pr-4">Alias</th>
                  <th className="text-left font-medium py-2 pr-4">Type</th>
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
      setResult(await importAliasList(marketplace, text, kind));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} title="Import aliases" subtitle="One line per product: the marketplace's alias, then the PIM SKU. Tab or comma between them. One alias per product." maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-label-md text-on-surface-variant">Marketplace</span>
            <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className={`mt-1 w-full ${inputCls}`}>
              {[...AMAZON, ...ALIAS_MARKETPLACES].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {!amazon && (
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
          placeholder={'S-300XG-CAN\tS-300XG\n3P-LVMJ-40J0\tA-802N'}
          className={`w-full font-mono text-body-sm ${inputCls}`}
        />
        {result && (
          <div className="text-body-sm rounded-lg px-3 py-2 bg-surface-container text-on-surface-variant space-y-1">
            <p>{result.written} aliases saved.{result.notInPim.length ? ` Not in the PIM, skipped: ${result.notInPim.slice(0, 12).join(', ')}${result.notInPim.length > 12 ? ` and ${result.notInPim.length - 12} more` : ''}.` : ''}</p>
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
