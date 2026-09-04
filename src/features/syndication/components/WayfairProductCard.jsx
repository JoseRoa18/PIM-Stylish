import { useState } from 'react';
import { Loader2, ShieldCheck, Save, Send } from 'lucide-react';
import { setWayfairItemGroupId } from '../api/wayfairSync';
import { formatTimeAgo } from '@/lib/format';
import { useAuth } from '@/features/auth/AuthContext';
import WayfairPushDialog from './WayfairPushDialog';

// Per-product Wayfair panel (Marketplaces tab): the item-group id, and one
// "Review push" that shows exactly what would travel before anything is sent.
export default function WayfairProductCard({ product, onUpdate }) {
  // Viewers see the card read-only: no group-id editing, no push.
  const { canEdit } = useAuth();
  const [groupId, setGroupId] = useState(product.wayfair_item_group_id ?? '');
  const [savingId, setSavingId] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [reviewing, setReviewing] = useState(false);

  const dirty = (groupId.trim() || null) !== (product.wayfair_item_group_id ?? null);

  async function saveGroupId() {
    setSavingId(true);
    setSaveError(null);
    try {
      await setWayfairItemGroupId(product.sku, groupId);
      onUpdate?.({ wayfair_item_group_id: groupId.trim() || null });
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSavingId(false);
    }
  }

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <div className="px-8 py-5 border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-wayfair/15 text-brand-wayfair flex items-center justify-center text-label-lg font-bold flex-shrink-0">
            WF
          </div>
          <div>
            <h2 className="text-title-lg text-on-surface leading-tight">Wayfair Canada</h2>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Wayfair API · {product.wayfair_synced_at
                ? `last pushed ${formatTimeAgo(product.wayfair_synced_at)}`
                : 'not pushed yet'}
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-label-sm">
          <ShieldCheck className="w-3.5 h-3.5" /> Production
        </span>
      </div>

      <div className="px-8 py-5 space-y-3">
        <label className="block">
          <span className="text-label-md text-on-surface-variant">Wayfair item-group id</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              readOnly={!canEdit}
              placeholder="GTQE1086"
              className="flex-1 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md focus:outline-none focus:ring-2 focus:ring-primary/30 read-only:bg-surface-container-low read-only:text-on-surface-variant"
            />
            {canEdit && (
              <button
                type="button"
                onClick={saveGroupId}
                disabled={savingId || !dirty}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-outline-variant text-label-md hover:bg-surface-container-low transition-colors disabled:opacity-40"
              >
                {savingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save
              </button>
            )}
          </div>
          {saveError && <span className="text-body-sm text-error">{saveError}</span>}
        </label>

        <p className="text-body-sm text-on-surface-variant">
          A push sends spec attributes, images, videos and documents, in that order, after you review them. Title, description, bullets and prices never travel.
        </p>

        {canEdit && (
          <button
            type="button"
            onClick={() => setReviewing(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold hover:opacity-90 transition-opacity"
          >
            <Send className="w-4 h-4" />
            Review push…
          </button>
        )}
      </div>

      {reviewing && (
        <WayfairPushDialog
          sku={product.sku}
          supplier="CAN"
          label="Wayfair Canada"
          onClose={() => setReviewing(false)}
          onPushed={() => onUpdate?.({ wayfair_synced_at: new Date().toISOString() })}
        />
      )}
    </section>
  );
}
