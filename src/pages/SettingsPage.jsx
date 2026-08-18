import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, AlertTriangle, CheckCircle2, Play, Zap } from 'lucide-react';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import { getAppSetting, saveAppSetting, runPromoApplyNow } from '@/features/settings/api/appSettings';
import { listPromotions } from '@/features/pricing/api/promotions';
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

export default function SettingsPage() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState(null);
  const [promotions, setPromotions] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runReport, setRunReport] = useState(null);

  useEffect(() => {
    Promise.all([
      getAppSetting('promo_automation', { enabled: true, wix: true, bestbuy: true }),
      listPromotions(),
    ])
      .then(([s, promos]) => {
        setSettings({ enabled: true, wix: true, bestbuy: true, ...s });
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
      message: 'Same as the month-start run: ends past promos, applies this month\'s, pushes Wix and re-schedules Best Buy. Safe to re-run.',
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
    parts.push(r.target ? `Applied "${r.target.name}"` : 'No promotion loaded for this month');
    if (r.store) parts.push(`${r.store.on_sale} on sale, ${r.store.cleared} cleared`);
    if (r.wix) parts.push(`Wix CA ${r.wix.sinksdirect_ca.pushed}/${r.wix.sinksdirect_ca.linked} · Wix US ${r.wix.sinksdirect_us.pushed}/${r.wix.sinksdirect_us.linked}`);
    if (r.bestbuy) parts.push(`Best Buy ${r.bestbuy.listed} scheduled`);
    if (r.errors?.length) parts.push(`⚠ ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`);
    return parts.join(' · ');
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
                The month's promo applies itself on the 1st at 00:00. Channels without a
                price API keep using the{' '}
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
            description="Promo prices pushed at midnight. Price fields only."
            checked={settings?.wix !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ wix: v })}
          />
          <SettingRow
            title="Best Buy Canada"
            description="Discounts scheduled when the list is loaded — turn on and off by themselves."
            checked={settings?.bestbuy !== false}
            disabled={!settings || settings?.enabled === false}
            onChange={(v) => update({ bestbuy: v })}
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
    </div>
  );
}
