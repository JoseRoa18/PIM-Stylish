import { CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { formatDate } from '@/lib/format';

/**
 * Promotions: did the monthly promo run on time on each market, how many
 * SKUs it carries, and what the automation reported last time.
 */
export default function PromoStatus({ promotions }) {
  if (!promotions) return null;
  const { promos, runs } = promotions;
  const current = promos.find((p) => p.status === 'active') ?? promos[0];
  const upcoming = promos.filter((p) => current && p.period > current.period).sort((a, b) => a.period.localeCompare(b.period))[0] ?? null;
  const lastRun = runs.find((r) => r.target === 'automation') ?? null;
  const report = lastRun?.metadata ?? null;

  if (!current) {
    return (
      <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest px-6 py-8 text-center text-body-sm text-on-surface-variant">No promotion loaded yet.</section>
    );
  }

  const periodLabel = (p) => new Date(`${p}T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const markets = [
    { key: 'us', label: 'USA', rule: 'day 1, 00:00 ET', at: current.us_applied_at, r: report?.us },
    { key: 'ca', label: 'Canada', rule: 'first Thursday, 00:00 ET', at: current.ca_applied_at, r: report?.ca },
    { key: 'bb', label: 'Best Buy', rule: 'scheduled the day before', at: current.bb_scheduled_at, r: null },
  ];

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-title-md text-on-surface">Promotions</h3>
          <p className="text-body-sm text-on-surface-variant mt-0.5">{current.name} · {periodLabel(current.period)} · {current.skus} SKU{current.skus === 1 ? '' : 's'} · {current.status}</p>
        </div>
        {upcoming && <p className="text-body-sm text-on-surface-variant">Next: {upcoming.name} · {upcoming.skus} SKU{upcoming.skus === 1 ? '' : 's'}{upcoming.bb_scheduled_at ? ' · Best Buy scheduled' : ''}</p>}
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-outline-variant">
        {markets.map((m) => {
          const Icon = m.at ? CheckCircle2 : Clock;
          const tone = m.at ? 'text-success' : 'text-on-surface-variant';
          return (
            <div key={m.key} className="px-6 py-5">
              <div className="flex items-center gap-2">
                <Icon className={`w-4 h-4 ${tone}`} />
                <p className="text-body-md text-on-surface font-medium">{m.label}</p>
              </div>
              <p className="text-body-sm text-on-surface-variant mt-1">{m.at ? `Applied ${formatDate(m.at)}` : 'Not applied yet'} · {m.rule}</p>
              {m.r && (
                <p className="text-body-sm mt-2">
                  <span className="text-on-surface">{m.r.pushed ?? 0} pushed</span>
                  <span className="text-on-surface-variant"> · {m.r.members ?? 0} members · {m.r.linked ?? 0} linked</span>
                  {m.r.failed > 0 && <span className="text-error"> · {m.r.failed} failed</span>}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {lastRun && (
        <p className={`px-6 py-3 border-t border-outline-variant text-body-sm flex items-center gap-2 ${report?.ok === false ? 'text-error' : 'text-on-surface-variant'}`}>
          {report?.ok === false ? <AlertCircle className="w-4 h-4 flex-shrink-0" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0" />}
          Last automation run {formatDate(lastRun.occurred_at)}: {lastRun.summary.replace(/^Promo automation:\s*/, '')}
        </p>
      )}
    </section>
  );
}
