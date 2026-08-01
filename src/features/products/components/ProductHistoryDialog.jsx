import { useEffect, useState } from 'react';
import { Loader2, History, RotateCcw } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { humanizeFieldName } from '@/lib/humanize';
import { formatTimeAgo } from '@/lib/format';
import { listProductHistory, groupHistory } from '../api/history';
import { updateProduct } from '../api/products';

// Identity/link fields never get a one-click revert — changing them has
// side effects (routing, channel links) that deserve a deliberate edit.
const NON_REVERTIBLE = new Set(['sku', 'wix_product_id', 'wayfair_item_group_id']);

function ValueText({ value }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-on-surface-variant/70">—</span>;
  }
  if (typeof value === 'object') {
    return (
      <details className="inline-block align-top">
        <summary className="cursor-pointer text-primary text-label-sm">complex value</summary>
        <pre className="mt-1 max-w-xs max-h-40 overflow-auto rounded-lg bg-surface-container-low p-2 text-code-sm whitespace-pre-wrap break-all">
          {JSON.stringify(value, null, 1)}
        </pre>
      </details>
    );
  }
  return <span className="break-all">{String(value)}</span>;
}

/** Field-level change history for a product, grouped per save/actor. */
export default function ProductHistoryDialog({ sku, onClose, onReverted }) {
  const { canEdit } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [reverting, setReverting] = useState(null); // history row id

  async function load() {
    try {
      setRows(await listProductHistory(sku));
    } catch (err) {
      setError(err.message ?? 'Could not load the history');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku]);

  async function handleRevert(row) {
    const label = humanizeFieldName(row.field);
    const ok = await confirm({
      title: `Revert ${label}?`,
      message: `Sets ${label} back to its previous value. This is a normal edit — it gets logged too.`,
      confirmLabel: 'Revert',
    });
    if (!ok) return;
    setReverting(row.id);
    setError(null);
    try {
      await updateProduct(sku, { [row.field]: row.old_value });
      onReverted?.();
      await load();
    } catch (err) {
      setError(err.message ?? 'Revert failed');
    } finally {
      setReverting(null);
    }
  }

  const groups = rows ? groupHistory(rows) : [];

  return (
    <Dialog
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <History className="w-5 h-5 text-on-surface-variant" /> History — {sku}
        </span>
      }
      subtitle="Every field change since Aug 2026, newest first. Wix/Wayfair sync timestamps are not tracked."
      maxWidth="max-w-2xl"
    >
      {error && <p className="mb-3 text-body-sm text-error">{error}</p>}

      {rows === null ? (
        <div className="flex items-center justify-center py-10 text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history…
        </div>
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-body-sm text-on-surface-variant">
          No recorded changes for this product yet.
        </p>
      ) : (
        <ol className="space-y-5">
          {groups.map((g) => (
            <li key={`${g.actorKey}-${g.changedAt}`}>
              <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <span className="text-body-sm font-medium text-on-surface">
                  {g.actorEmail ?? 'System / maintenance'}
                </span>
                <span
                  className="text-label-md text-on-surface-variant whitespace-nowrap"
                  title={new Date(g.changedAt).toLocaleString('en-US')}
                >
                  {formatTimeAgo(g.changedAt)}
                </span>
              </div>
              <ul className="rounded-xl border border-outline-variant divide-y divide-outline-variant/60">
                {g.rows.map((row) => (
                  <li key={row.id} className="px-4 py-2.5 flex items-start gap-3">
                    <div className="min-w-0 flex-1 text-body-sm">
                      <span className="font-medium text-on-surface">
                        {humanizeFieldName(row.field)}
                      </span>
                      <div className="mt-0.5 text-on-surface-variant flex items-center gap-2 flex-wrap">
                        <ValueText value={row.old_value} />
                        <span aria-hidden="true">→</span>
                        <ValueText value={row.new_value} />
                      </div>
                    </div>
                    {canEdit && !NON_REVERTIBLE.has(row.field) && (
                      <button
                        type="button"
                        onClick={() => handleRevert(row)}
                        disabled={reverting !== null}
                        title="Set the field back to the previous value"
                        className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-label-sm font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
                      >
                        {reverting === row.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                        Revert
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
