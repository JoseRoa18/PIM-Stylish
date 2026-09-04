import { nameFromEmail } from '@/lib/format';
import { MARKETPLACES } from '@/features/dashboard/lib/listingHealth';
import { DeltaChip } from './charts';

const TARGET_LABEL = { wix: 'Wix', wayfair: 'Wayfair', bestbuy: 'Best Buy', walmart_us: 'Walmart US', amazon: 'Amazon', automation: 'Promo automation' };

// What the team did in the selected week, from the audit log: per person and
// in total, against the previous week.
const hm = (min) => (min == null ? '—' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`);

export default function TeamActivity({ activity, prevActivity, week, onOpen, screen, prevScreen }) {
  if (!activity) {
    return <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest h-40 animate-pulse" aria-label="Loading team activity" />;
  }
  const t = activity.totals;
  const p = prevActivity?.totals;
  const pushes = Object.entries(activity.pushesByTarget).sort((a, b) => b[1] - a[1]);
  const screenTotal = screen ? [...screen.values()].reduce((a, s) => a + s.minutes, 0) : null;
  const prevScreenTotal = prevScreen ? [...prevScreen.values()].reduce((a, s) => a + s.minutes, 0) : null;
  // People who were on screen but logged no activity still belong in the table.
  const rows = [...activity.people];
  for (const s of screen?.values() ?? []) {
    if (!rows.some((r) => r.email === s.email)) rows.push({ email: s.email, name: s.name, touched: 0, edits: 0, uploads: 0, pushes: 0, tests: 0, creates: 0, total: 0 });
  }
  rows.sort((a, b) => (b.total + (screen?.get(b.email)?.minutes ?? 0) / 60) - (a.total + (screen?.get(a.email)?.minutes ?? 0) / 60));
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
      <header className="px-6 py-4 border-b border-outline-variant flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-title-md text-on-surface">Team activity</h3>
          <p className="text-body-sm text-on-surface-variant mt-0.5">{week.name} · {week.range} · from the activity log · {activity.events} events</p>
        </div>
        <div className="flex items-center gap-6 text-body-sm">
          <Total label="Edits" value={t.edits} prev={p?.edits} onClick={() => onOpen?.({ kind: 'edits' })} />
          <Total label="Media uploaded" value={t.uploads} prev={p?.uploads} onClick={() => onOpen?.({ kind: 'uploads' })} />
          <Total label="Pushes" value={t.pushes} prev={p?.pushes} onClick={() => onOpen?.({ kind: 'pushes' })} />
          <Total label="New products" value={t.creates} prev={p?.creates} onClick={() => onOpen?.({ kind: 'creates' })} />
          {screenTotal != null && (
            <div className="text-right">
              <div className="text-label-md text-on-surface-variant">On screen</div>
              <div className="text-title-md text-on-surface font-semibold tabular-nums">{hm(screenTotal)}</div>
              <DeltaChip value={prevScreenTotal == null ? null : Math.round((screenTotal - prevScreenTotal) / 60 * 10) / 10} suffix=" h" upIsGood vs="last week" />
            </div>
          )}
        </div>
      </header>
      {rows.length === 0 ? (
        <div className="px-6 py-10 text-center text-body-sm text-on-surface-variant">No activity recorded in this week.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="bg-surface-container-low/60 border-b border-outline-variant text-label-md text-on-surface-variant">
                <th className="text-left px-6 py-3 font-medium">Person</th>
                <th className="text-right px-6 py-3 font-medium" title="Active minutes with the PIM open and in use">On screen</th>
                <th className="text-right px-6 py-3 font-medium">Products touched</th>
                <th className="text-right px-6 py-3 font-medium">Edits</th>
                <th className="text-right px-6 py-3 font-medium">Media</th>
                <th className="text-right px-6 py-3 font-medium">Pushes</th>
                <th className="text-right px-6 py-3 font-medium" title="Sandbox pushes: validated at the channel, nothing changed live">Tests</th>
                <th className="text-right px-6 py-3 font-medium">New</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {rows.map((person) => (
                <tr key={person.email} onClick={() => onOpen?.({ actor: person.email, label: person.name || nameFromEmail(person.email) || 'System' })} className="cursor-pointer hover:bg-surface-container-low/40 transition-colors" title="See everything this person did this week">
                  <td className="px-6 py-3">
                    <div className="text-body-md text-on-surface font-medium">{person.name || nameFromEmail(person.email) || 'System'}</div>
                    <div className="text-body-sm text-on-surface-variant">{person.email}</div>
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{screen ? hm(screen.get(person.email)?.minutes ?? 0) : '—'}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{person.touched}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{person.edits}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{person.uploads}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{person.pushes}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface-variant">{person.tests || '—'}</td>
                  <td className="px-6 py-3 text-right tabular-nums text-on-surface">{person.creates}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pushes.length > 0 && (
        <p className="px-6 py-3 border-t border-outline-variant text-body-sm text-on-surface-variant">
          Pushes by channel: {pushes.map(([k, n]) => `${MARKETPLACES[k]?.label ?? TARGET_LABEL[k] ?? k} ${n}`).join(' · ')}
        </p>
      )}
    </section>
  );
}

function Total({ label, value, prev, onClick }) {
  return (
    <button type="button" onClick={onClick} className="text-right rounded-lg px-2 py-1 -my-1 hover:bg-surface-container-low/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" title={`See the ${label.toLowerCase()} of this week`}>
      <div className="text-label-md text-on-surface-variant">{label}</div>
      <div className="text-title-md text-on-surface font-semibold tabular-nums">{value}</div>
      <DeltaChip value={prev == null ? null : value - prev} upIsGood vs="last week" />
    </button>
  );
}
