import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Eye, Send } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { formatTimeAgo } from '@/lib/format';
import { walmartUsStock } from '../api/walmartAdd';

// Walmart USA stock sync (walmart-us-inventory, user 2026-10-30): every hour,
// while the switch is on, every product listed on Walmart USA gets our USA
// stock (ShipStation) minus 2 units of safety margin; a product we do not
// track goes as 0. Shows Walmart's answer to the last feed.
export default function WalmartUsStockCard() {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null); // 'load' | 'switch' | 'preview' | 'send'
  const [error, setError] = useState(null);

  const run = async (kind, body) => {
    setBusy(kind); setError(null);
    try { return await walmartUsStock(body); } catch (e) { setError(e.message); return null; } finally { setBusy(null); }
  };
  const load = async () => { const s = await run('load', { mode: 'status' }); if (s) setStatus(s); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async () => {
    const enabled = !status?.enabled;
    if (enabled && !(await confirm({
      title: 'Turn on the Walmart USA stock sync?',
      message: `Every hour the PIM will send Walmart USA our USA stock minus ${status?.safetyUnits ?? 2} units for every product listed there (0 when we do not track it). The first run sends every listed product.`,
      confirmLabel: 'Turn on',
    }))) return;
    if (await run('switch', { mode: 'switch', enabled })) await load();
  };
  const showPreview = async () => { const p = await run('preview', { mode: 'push', dryRun: true, all: true }); if (p) setPreview(p); };
  const sendNow = async () => {
    if (!(await confirm({ title: 'Send the stock to Walmart USA now?', message: 'Sends every listed product’s quantity now, without waiting for the hourly run.', confirmLabel: 'Send now' }))) return;
    if (await run('send', { mode: 'push', all: true })) { setPreview(null); await load(); }
  };

  const last = status?.last;
  const on = Boolean(status?.enabled);
  const btn = 'inline-flex items-center gap-2 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50';

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-6 py-5 border-b border-outline-variant flex items-start justify-between gap-4 flex-wrap">
        <div className="max-w-3xl">
          <h2 className="text-title-lg text-on-surface leading-tight">Stock sync</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Every hour, every product listed on Walmart USA gets our USA stock (ShipStation, Flowery Branch) minus {status?.safetyUnits ?? 2} units of safety margin; a product we do not track goes as 0, and one without stock stays listed at 0.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-label-lg text-on-surface">{status ? (on ? 'On' : 'Off') : '…'}</span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Walmart USA stock sync"
            disabled={!canEdit || !status || busy != null}
            onClick={toggle}
            className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${on ? 'bg-primary' : 'bg-outline-variant'}`}
          >
            <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-surface shadow transition-transform" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
          </button>
        </div>
      </div>

      <div className="px-6 py-4 space-y-3">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg px-3 py-2 text-body-sm bg-error-container text-on-error-container">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" /><span className="break-words">{error}</span>
          </div>
        )}
        <p role="status" className="text-body-sm text-on-surface-variant">
          {busy === 'load' && !status ? 'Loading…'
            : last ? `Last sent ${formatTimeAgo(last.at)}: ${last.count} product${last.count === 1 ? '' : 's'}${last.all ? ' (all listed)' : ' (changed quantities)'} · Walmart: ${last.feedStatus || 'received'}${last.itemsFailed ? ` · ${last.itemsFailed} failed` : ''}`
            : 'Nothing sent yet.'}
        </p>
        {last?.errors?.length > 0 && (
          <ul className="text-body-sm text-error space-y-0.5">
            {last.errors.map((e) => <li key={e.sku}>{e.sku}: {e.error}</li>)}
          </ul>
        )}
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={showPreview} disabled={busy != null} className={btn} title="What the next full run would send. Nothing is sent.">
              {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              Preview
            </button>
            <button type="button" onClick={sendNow} disabled={busy != null || !on} className={btn} title={on ? undefined : 'Turn the sync on first'}>
              {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
              Send now
            </button>
          </div>
        )}
        {preview && (
          <div className="rounded-lg border border-outline-variant overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="text-left px-3 py-2 text-on-surface-variant">{preview.listed} product{preview.listed === 1 ? '' : 's'} listed on Walmart USA</caption>
              <thead className="bg-surface-container-low text-label-sm text-on-surface-variant">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">SKU</th>
                  <th scope="col" className="px-3 py-2 text-right">Our USA stock</th>
                  <th scope="col" className="px-3 py-2 text-right">Sent to Walmart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/60">
                {(preview.lines ?? []).map((l) => (
                  <tr key={l.sku}>
                    <td className="px-3 py-1.5 font-mono">{l.sku}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.ours == null ? <span className="text-on-surface-variant">Not tracked</span> : l.ours}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{l.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
