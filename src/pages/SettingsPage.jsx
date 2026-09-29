import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, AlertTriangle, CheckCircle2, Play, Zap, Package, RefreshCw, Upload, UserCheck } from 'lucide-react';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { getAppSetting, saveAppSetting, runPromoApplyNow } from '@/features/settings/api/appSettings';
import { getInventoryReport, refreshInventory, uploadCanadaInventory, describeInventoryPull, stockAge } from '@/features/pricing/api/inventory';
import { listPromotions } from '@/features/pricing/api/promotions';
import { listTaskOwners } from '@/features/pricing/api/promoTasks';
import { TASK_CHANNELS } from '@/features/pricing/lib/promoTasks';
import { logActivity } from '@/features/activity/api/activityLog';
import { Link } from 'react-router-dom';

function monthLabel(period) {
  if (!period) return '';
  const [y, m] = String(period).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

function periodOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function Switch({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full flex-shrink-0 transition-colors disabled:opacity-40 ${
        checked ? 'bg-primary' : 'bg-surface-container-highest border border-outline-variant'
      }`}
    >
      <span
        className={`absolute left-0 top-0.5 w-5 h-5 rounded-full shadow-sm transition-transform ${
          checked ? 'bg-on-primary translate-x-[22px]' : 'bg-on-surface-variant/70 translate-x-0.5'
        }`}
      />
    </button>
  );
}

function SettingRow({ title, description, checked, disabled, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-body-md text-on-surface font-medium">{title}</p>
        <p className="text-body-sm text-on-surface-variant mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={title} />
    </div>
  );
}

// Stock sources: USA from ShipStation on its own (hourly); Canada from the
// "Stylish Inventory" workbook, mailed daily to the PIM mailbox
// (scripts/gmail-inventory-to-pim.gs) or uploaded here. The last pull's
// report per market comes from app_settings.
const STOCK_SOURCES = [
  { key: 'us', title: 'USA — ShipStation', description: 'Every hour, and right after a product is created.' },
  { key: 'ca', title: 'Canada — "Stylish Inventory" file', description: 'From the daily email, or the file uploaded here. A SKU not in the file is not tracked.' },
];

function describeSource(r) {
  if (!r) return 'not loaded yet';
  if (r.skipped) return r.note ?? 'unchanged';
  if (!r.ok) return r.error ?? 'not loaded yet';
  const bits = [`${r.matched} SKUs tracked`, `${r.inStock} in stock`];
  if (r.outOfStock) bits.push(`${r.outOfStock} at 0`);
  if (r.unmatched?.length) bits.push(`${r.unmatched.length} not in the PIM`);
  const how = r.via === 'email' ? `emailed${r.file ? ` "${r.file}"` : ''}`
    : r.via === 'upload' ? `uploaded${r.file ? ` "${r.file}"` : ''}`
    : r.via ? `SharePoint (${r.via})` : 'ShipStation';
  return `${bits.join(', ')} · ${how} · ${stockAge(r.syncedAt)}`;
}

// Who answers for each channel whose promotion files go through its own
// portal (Wayfair Canada / USA): the PromoTaskNudge reminders go to that
// person only; a channel without an owner reminds every admin.
function PromoOwnersSection() {
  const [owners, setOwners] = useState(null);
  const [people, setPeople] = useState([]);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([getAppSetting('promo_channel_owners', {}), listTaskOwners()])
      .then(([o, list]) => { setOwners(o ?? {}); setPeople(list); })
      .catch((err) => setError(err.message));
  }, []);

  async function change(key, value) {
    const prev = owners;
    const next = { ...owners };
    if (value) next[key] = value;
    else delete next[key];
    setOwners(next);
    setSaving(key);
    setError(null);
    try {
      await saveAppSetting('promo_channel_owners', next);
      const channel = TASK_CHANNELS.find((c) => c.key === key);
      const person = people.find((x) => x.id === value);
      logActivity({
        action: 'update',
        entityType: 'setting',
        entityId: 'promo_channel_owners',
        summary: `${channel?.label ?? key} promotion files: ${person ? person.full_name || person.email : 'no owner (every admin)'}`,
        metadata: next,
      });
    } catch (err) {
      setOwners(prev);
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="rounded-2xl bg-surface p-6 border border-outline-variant">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <UserCheck className="w-5 h-5" strokeWidth={2} />
        </div>
        <div>
          <h2 className="text-title-md text-on-surface font-semibold">Promotion file owners</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5 max-w-md">
            Who gets the reminders for the marketplaces whose files go through their portal: the promotions file and the promo MAP when a promotion starts, and the price change back to Blue when it ends. Without an owner, every admin gets them.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-surface-container-low/60 p-4 space-y-3">
        {owners === null && !error ? (
          <p className="text-body-sm text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading…
          </p>
        ) : TASK_CHANNELS.map((c) => (
          <label key={c.key} className="flex items-center justify-between gap-4">
            <span className="text-label-lg font-medium text-on-surface">{c.label}</span>
            <span className="inline-flex items-center gap-2">
              {saving === c.key && <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />}
              <select
                value={owners?.[c.key] ?? ''}
                onChange={(e) => change(c.key, e.target.value || null)}
                disabled={saving !== null || owners === null}
                className="px-3 py-2 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              >
                <option value="">No owner (every admin)</option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>{x.full_name || x.email}</option>
                ))}
              </select>
            </span>
          </label>
        ))}
        {error && <p className="text-body-sm rounded-lg px-3 py-2 bg-error-container/60 text-on-error-container">{error}</p>}
      </div>
    </section>
  );
}

function InventorySection() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null); // 'refresh' | 'upload'
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    getInventoryReport().then((r) => setReport(r ?? {})).catch(() => setReport({}));
  }, []);

  async function refresh() {
    setBusy('refresh');
    setMsg(null);
    try {
      const r = await refreshInventory();
      setReport((await getInventoryReport()) ?? {});
      setMsg({ tone: r.ok ? 'success' : 'error', text: describeInventoryPull(r).join(' · ') });
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function upload(file) {
    if (!file) return;
    setBusy('upload');
    setMsg(null);
    try {
      const r = await uploadCanadaInventory(file);
      setReport((await getInventoryReport()) ?? {});
      const ca = r.markets?.ca;
      setMsg(ca?.ok
        ? { tone: 'success', text: `"${file.name}" loaded — ${describeInventoryPull(r).join(' · ')}` }
        : { tone: 'error', text: ca?.error ?? r.error ?? 'The file could not be loaded.' });
    } catch (err) {
      setMsg({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  }

  const markets = report?.markets ?? {};
  return (
    <section className="rounded-2xl bg-surface p-6 border border-outline-variant">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
          <Package className="w-5 h-5" strokeWidth={2} />
        </div>
        <div>
          <h2 className="text-title-md text-on-surface font-semibold">Stock</h2>
          <p className="text-body-sm text-on-surface-variant mt-0.5 max-w-md">
            Shown in the catalog, on each product and in the promotion tables. A missing SKU is "not tracked", never 0.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-surface-container-low/60 p-4 space-y-3">
        {report === null ? (
          <p className="text-body-sm text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading…
          </p>
        ) : (
          STOCK_SOURCES.map(({ key, title, description }) => {
            const r = markets[key];
            const fine = Boolean(r?.ok);
            return (
              <div key={key} className="flex items-start gap-2 text-body-sm">
                {fine ? (
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-on-surface-variant flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-on-surface font-medium">{title} <span className="font-normal text-on-surface-variant">— {describeSource(r)}</span></p>
                  <p className="text-on-surface-variant">{description}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={refresh}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
        >
          {busy === 'refresh' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh now
        </button>
        <label className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors cursor-pointer ${busy !== null ? 'opacity-40 pointer-events-none' : ''}`}>
          {busy === 'upload' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Upload the Canada file (.xlsx)
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
          />
        </label>
      </div>

      {msg && (
        <p className={`mt-3 text-body-sm rounded-lg px-3 py-2 inline-flex items-start gap-2 ${msg.tone === 'error' ? 'bg-error-container/60 text-on-error-container' : 'bg-surface-container text-on-surface-variant'}`}>
          {msg.tone === 'error' ? <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          {msg.text}
        </p>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState(null);
  const [promotions, setPromotions] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runReport, setRunReport] = useState(null);

  useEffect(() => {
    Promise.all([
      getAppSetting('promo_automation', { enabled: true, wix: true, bestbuy: true, walmart_ca: true, walmart_us: true }),
      listPromotions(),
    ])
      .then(([s, promos]) => {
        setSettings({ enabled: true, wix: true, bestbuy: true, walmart_ca: true, walmart_us: true, ...s });
        setPromotions(promos);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function update(patch) {
    const prev = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    try {
      await saveAppSetting('promo_automation', next);
      logActivity({
        action: 'update',
        entityType: 'setting',
        entityId: 'promo_automation',
        summary: `Promo automation settings changed: ${Object.entries(patch).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}`,
        metadata: next,
      });
    } catch (err) {
      setSettings(prev);
      setError(err.message);
    }
  }

  // The two months automation cares about: this one (what the cron applied /
  // would apply) and the next one (what needs loading before its 1st).
  const promoStatus = useMemo(() => {
    if (!promotions) return null;
    const now = new Date();
    const current = periodOf(now);
    const next = periodOf(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    const find = (p) => promotions.find((x) => x.period === p && x.status !== 'ended') ?? null;
    return [
      { period: current, promo: find(current), tag: 'current' },
      { period: next, promo: find(next), tag: 'next' },
    ];
  }, [promotions]);

  async function runNow() {
    const ok = await confirm({
      title: 'Run promotion automation now?',
      message: 'Re-applies what should be live today on both markets (USA + Canada), re-schedules Best Buy and schedules Walmart Canada / USA when they are not yet. Safe to re-run.',
      confirmLabel: 'Run now',
    });
    if (!ok) return;
    setRunning(true);
    setRunReport(null);
    setError(null);
    try {
      const r = await runPromoApplyNow();
      setRunReport(r);
      setPromotions(await listPromotions());
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  const summarizeRun = (r) => {
    if (!r) return '';
    if (r.skipped) return `Skipped: ${r.skipped}`;
    const parts = [];
    if (r.target?.us || r.target?.ca) parts.push(`USA "${r.target.us ?? '—'}" · CAN "${r.target.ca ?? '—'}"`);
    if (r.store) parts.push(`${r.store.on_sale} on sale, ${r.store.cleared} cleared`);
    if (r.us) parts.push(`Wix US ${r.us.pushed}/${r.us.linked}`);
    if (r.ca) parts.push(`Wix CA ${r.ca.pushed}/${r.ca.linked}`);
    if (r.wix_owed) parts.push(r.wix_continuing ? `Wix: ${r.wix_owed} more going out in the background` : `Wix: ${r.wix_owed} left`);
    if (r.bestbuy || r.prep) parts.push(`Best Buy ${(r.bestbuy ?? r.prep).listed} scheduled`);
    for (const [key, label] of [['walmart_ca', 'Walmart CA'], ['walmart_ca_prep', 'Walmart CA'], ['walmart_us', 'Walmart US'], ['walmart_us_prep', 'Walmart US']]) {
      const w = r[key];
      if (!w) continue;
      parts.push(w.skipped ? `${label}: ${w.skipped}` : `${label} ${w.attempted} scheduled${w.itemsFailed ? ` (${w.itemsFailed} rejected)` : ''}`);
    }
    if (r.errors?.length) parts.push(`⚠ ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'Nothing to do today';
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-headline-md text-on-surface font-semibold">Settings</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Rules for what the PIM does on its own.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-error-container/60 text-on-error-container px-4 py-3 text-body-sm">
          {error}
        </div>
      )}

      <section className="rounded-2xl bg-surface p-6 border border-outline-variant space-y-1">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
              <CalendarClock className="w-5 h-5" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-title-md text-on-surface font-semibold">Promotion automation</h2>
              <p className="text-body-sm text-on-surface-variant mt-0.5 max-w-md">
                USA: the 1st · Canada: first Thursday (00:00 ET), scheduled a day
                ahead. Channels without a price API keep using the{' '}
                <Link to="/pricing" className="text-primary hover:underline">promo files</Link>.
              </p>
            </div>
          </div>
          <Switch
            checked={settings?.enabled !== false}
            disabled={!settings}
            onChange={(v) => update({ enabled: v })}
            label="Promotion automation"
          />
        </div>

        <div className="divide-y divide-outline-variant/50 mt-3 sm:ml-13">
          <SettingRow
            title="Wix — SinksDirect Canada & USA"
            description="USA flips the 1st, Canada the first Thursday. Price fields only."
            checked={settings?.wix !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ wix: v })}
          />
          <SettingRow
            title="Best Buy Canada"
            description="Discounts scheduled the day before Canada’s window — flip by themselves."
            checked={settings?.bestbuy !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ bestbuy: v })}
          />
          <SettingRow
            title="Walmart Canada"
            description="Promo prices sent through the Walmart API the day before Canada’s window — Walmart turns them on and off by itself."
            checked={settings?.walmart_ca !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ walmart_ca: v })}
          />
          <SettingRow
            title="Walmart USA"
            description="Promo prices sent through the Walmart API the day before the 1st — Walmart turns them on and off by itself."
            checked={settings?.walmart_us !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ walmart_us: v })}
          />
        </div>

        <div className="mt-4 rounded-xl bg-surface-container-low/60 p-4 space-y-2">
          <p className="text-label-lg font-medium text-on-surface">Promotion status</p>
          {promoStatus === null ? (
            <p className="text-body-sm text-on-surface-variant">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1.5 align-middle" />Loading…
            </p>
          ) : (
            promoStatus.map(({ period, promo, tag }) => (
              <div key={period} className="flex items-center gap-2 text-body-sm flex-wrap">
                {promo ? (
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-on-surface-variant flex-shrink-0" />
                )}
                <span className="text-on-surface font-medium">{monthLabel(period)}</span>
                <span className="text-on-surface-variant">
                  {promo
                    ? `${promo.sku_count} SKUs${promo.bb_schedule ? ` · Best Buy ✓` : ' · Best Buy pending'}`
                    : tag === 'next'
                      ? 'not loaded yet'
                      : 'no promotion'}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={runNow}
            disabled={running || settings?.enabled === false}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-outline-variant bg-surface text-label-lg font-medium text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-40"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run now
          </button>
          <p className="text-body-sm text-on-surface-variant inline-flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Next run: {monthLabel(periodOf(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)))} 1, 00:00.
          </p>
        </div>

        {runReport && (
          <p className={`mt-2 text-body-sm rounded-lg px-3 py-2 inline-flex items-center gap-2 ${runReport.errors?.length ? 'bg-error-container/60 text-on-error-container' : 'bg-surface-container text-on-surface-variant'}`}>
            {runReport.errors?.length ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
            {summarizeRun(runReport)}
          </p>
        )}
      </section>

      <PromoOwnersSection />

      <InventorySection />
    </div>
  );
}
