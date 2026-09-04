import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Image as ImageIcon, Film, FileText, Ruler } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { planWayfairPush, pushWayfairMedia, pushWayfairAttributes, checkWayfairRequestStatus, setWayfairLeadImage } from '../api/wayfairSync';

const STEP_ICON = { specs: Ruler, images: ImageIcon, videos: Film, documents: FileText };
const thumb = (url) => url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=96&height=96&resize=contain';

/**
 * Review before pushing to Wayfair: every step in the order it will run,
 * every item it contains, and the spec changes it would make. Nothing is
 * sent until "Push" is pressed; title, description, bullets and prices are
 * never sent at all.
 */
export default function WayfairPushDialog({ sku, supplier = 'CAN', market, label = 'Wayfair Canada', onClose, onPushed }) {
  const [plan, setPlan] = useState(null);
  const [specs, setSpecs] = useState(null);
  const [error, setError] = useState(null);
  const [enabled, setEnabled] = useState({ specs: true, images: true, videos: true, documents: true });
  const [phase, setPhase] = useState('review'); // review | pushing | done
  const [progress, setProgress] = useState([]); // [{ key, label, state, requestId, error, count }]
  const [status, setStatus] = useState({});
  const [lead, setLead] = useState(null); // null | 'busy' | { requestId } | { error }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [p, s] = await Promise.all([
          planWayfairPush(sku, { supplier, market }),
          pushWayfairAttributes(sku, { dryRun: true, supplier, market }).catch((e) => ({ error: e.message })),
        ]);
        if (!active) return;
        setPlan(p);
        setSpecs(s);
      } catch (e) {
        if (active) setError(e.message);
      }
    })();
    return () => { active = false; };
  }, [sku, supplier, market]);

  const specChanges = specs && !specs.error ? Object.entries(specs.diff ?? {}).filter(([, v]) => v.changed) : [];
  const steps = [
    { key: 'specs', label: 'Spec attributes', count: specChanges.length, note: specs?.error ? specs.error : specs ? `${specs.updates} mapped · ${specChanges.length} differ from Wayfair` : 'checking…' },
    ...(plan?.steps ?? []).map((s) => ({ key: s.key, label: s.label, count: s.items.length, note: s.note, items: s.items })),
  ];
  const active = steps.filter((s) => enabled[s.key] && s.count > 0);

  async function push() {
    setPhase('pushing');
    const log = [];
    const record = (entry) => { log.push(entry); setProgress([...log]); };
    try {
      if (enabled.specs && specChanges.length > 0) {
        record({ key: 'specs', label: 'Spec attributes', state: 'running', count: specChanges.length });
        try {
          const r = await pushWayfairAttributes(sku, { validateOnly: false, supplier, market });
          log[log.length - 1] = { ...log[log.length - 1], state: 'sent', requestId: r?.mutation?.requestId ?? null };
        } catch (e) {
          log[log.length - 1] = { ...log[log.length - 1], state: 'error', error: e.message };
        }
        setProgress([...log]);
      }
      const mediaSteps = { images: enabled.images, videos: enabled.videos, documents: enabled.documents };
      if (Object.values(mediaSteps).some(Boolean) && (plan?.steps ?? []).some((s) => mediaSteps[s.key] && s.items.length)) {
        for (const s of plan.steps) if (mediaSteps[s.key] && s.items.length) record({ key: s.key, label: s.label, state: 'running', count: s.items.length });
        const r = await pushWayfairMedia(sku, { steps: mediaSteps, supplier, market });
        for (const res of r.results ?? []) {
          const i = log.findIndex((l) => l.key === res.step);
          if (i >= 0) log[i] = { ...log[i], state: res.error ? 'error' : 'sent', requestId: res.requestId, error: res.error };
        }
        for (const l of log) if (l.state === 'running') l.state = 'skipped';
        setProgress([...log]);
      }
      onPushed?.();
    } finally {
      setPhase('done');
    }
  }

  const imagesRequest = progress.find((p) => p.key === 'images' && p.requestId);
  const imagesDone = imagesRequest && status[imagesRequest.requestId]?.status === 'COMPLETED' && !(status[imagesRequest.requestId]?.problems?.length);

  async function forceLead() {
    setLead('busy');
    try { setLead(await setWayfairLeadImage(sku, { supplier, market })); } catch (e) { setLead({ error: e.message }); }
  }

  async function refreshStatus() {
    const out = {};
    const ids = [...progress.map((p) => p.requestId), lead?.requestId].filter(Boolean);
    for (const id of ids) {
      try { out[id] = await checkWayfairRequestStatus(id, { supplier }); } catch (e) { out[id] = { error: e.message }; }
    }
    setStatus(out);
  }
  const leadStatus = lead?.requestId ? status[lead.requestId] : null;

  return (
    <Dialog
      onClose={onClose}
      title={`Push ${sku} to ${label}`}
      subtitle="What travels, in this order. Title, description, bullets and prices are never sent."
      maxWidth="max-w-3xl"
      footer={(
        <>
          {phase === 'review' && plan && (
            <span className="mr-auto text-body-sm text-on-surface-variant">
              {plan.listed ? `Listed on Wayfair · ${plan.wayfair?.className ?? ''} · ${plan.wayfair?.status ?? ''}` : 'Not in the Wayfair catalog — media cannot be pushed'}
              {plan.env !== 'production' ? ' · sandbox' : ''}
            </span>
          )}
          {phase === 'done' && (
            <span className="mr-auto inline-flex items-center gap-2 flex-wrap">
              <button type="button" onClick={refreshStatus} className="inline-flex items-center gap-2 px-3 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low"><RefreshCw className="w-4 h-4" />Check what Wayfair did</button>
              {imagesDone && (
                <button type="button" onClick={forceLead} disabled={lead === 'busy'} className="inline-flex items-center gap-2 px-3 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low disabled:opacity-60" title="Asks Wayfair to lead with the white main. Wayfair accepts the request, but in our tests Partner Home kept its own lead, so confirm it there">
                  {lead === 'busy' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                  Set the white main as lead
                </button>
              )}
              {lead && lead !== 'busy' && (
                <span className={`text-label-md ${lead.error || leadStatus?.problems?.length ? 'text-error' : 'text-success'}`}>
                  {lead.error ?? (leadStatus ? `lead ${leadStatus.status ?? leadStatus.error ?? ''}${leadStatus.problems?.length ? ` · ${leadStatus.problems.length} problems` : ''}` : `lead requested (${String(lead.requestId).slice(0, 8)}…)`)}
                </span>
              )}
            </span>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors">{phase === 'done' ? 'Close' : 'Cancel'}</button>
          {phase === 'review' && (
            <button type="button" onClick={push} disabled={!plan || !plan.listed || active.length === 0} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold enabled:hover:opacity-90 disabled:bg-on-surface/12 disabled:text-on-surface/38 disabled:cursor-not-allowed">
              Push {active.length} step{active.length === 1 ? '' : 's'} to {label}
            </button>
          )}
        </>
      )}
    >
      {error && <p className="text-body-sm text-error flex items-center gap-2"><AlertCircle className="w-4 h-4" />{error}</p>}
      {!plan && !error && <p className="text-body-sm text-on-surface-variant flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Preparing the push plan…</p>}

      {plan && phase === 'review' && (
        <ol className="space-y-3">
          {steps.map((s, i) => {
            const Icon = STEP_ICON[s.key];
            return (
              <li key={s.key} className={`rounded-xl border ${enabled[s.key] && s.count ? 'border-outline-variant' : 'border-outline-variant/60 opacity-70'} overflow-hidden`}>
                <label className="flex items-center gap-3 px-4 py-3 cursor-pointer">
                  <input type="checkbox" checked={enabled[s.key]} onChange={(e) => setEnabled({ ...enabled, [s.key]: e.target.checked })} disabled={!s.count} className="accent-primary" />
                  <span className="w-6 h-6 rounded-full bg-surface-container text-label-md font-semibold text-on-surface-variant inline-flex items-center justify-center">{i + 1}</span>
                  <Icon className="w-4 h-4 text-on-surface-variant" />
                  <span className="text-body-md text-on-surface font-medium">{s.label}</span>
                  <span className="text-body-sm text-on-surface-variant">· {s.count} {s.key === 'specs' ? 'change' : 'item'}{s.count === 1 ? '' : 's'}</span>
                  <span className="ml-auto text-body-sm text-on-surface-variant truncate max-w-xs" title={s.note}>{s.note}</span>
                </label>
                {s.key === 'specs' && specChanges.length > 0 && (
                  <div className="border-t border-outline-variant px-4 py-2 overflow-x-auto">
                    <table className="w-full text-body-sm">
                      <thead><tr className="text-label-md text-on-surface-variant"><th className="text-left py-1 font-medium">Attribute</th><th className="text-left py-1 font-medium">Wayfair now</th><th className="text-left py-1 font-medium">PIM (will be sent)</th></tr></thead>
                      <tbody>
                        {specChanges.map(([title, v]) => (
                          <tr key={title} className="border-t border-outline-variant/60">
                            <td className="py-1 pr-3 text-on-surface">{title}</td>
                            <td className="py-1 pr-3 text-on-surface-variant">{v.current ? v.current.join(', ') : '—'}</td>
                            <td className="py-1 text-on-surface font-medium">{v.new}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {s.items && s.items.length > 0 && (
                  <ol className="border-t border-outline-variant px-4 py-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    {s.items.map((it, j) => (
                      <li key={it.url} className="flex items-center gap-2 text-body-sm text-on-surface min-w-0">
                        <span className="w-5 text-on-surface-variant tabular-nums text-right">{j + 1}</span>
                        {it.kind === 'image' ? <img src={thumb(it.url)} alt="" className="w-8 h-8 rounded object-contain bg-white border border-outline-variant flex-shrink-0" loading="lazy" /> : null}
                        <span className="truncate" title={it.label}>{it.label}</span>
                        {it.lead && <span className="text-label-md text-primary font-semibold">lead</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {phase !== 'review' && (
        <ol className="space-y-2">
          {progress.map((p) => (
            <li key={p.key} className="flex items-center gap-3 text-body-sm rounded-xl border border-outline-variant px-4 py-3">
              {p.state === 'running' ? <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" /> : p.state === 'sent' ? <CheckCircle2 className="w-4 h-4 text-success" /> : p.state === 'error' ? <AlertCircle className="w-4 h-4 text-error" /> : <span className="w-4 h-4" />}
              <span className="text-on-surface font-medium">{p.label}</span>
              <span className="text-on-surface-variant">· {p.count} {p.key === 'specs' ? 'changes' : 'items'}</span>
              <span className="ml-auto text-on-surface-variant font-mono truncate max-w-[16rem]">{p.error ? <span className="text-error font-sans">{p.error}</span> : p.requestId ? `request ${p.requestId}` : p.state}</span>
              {p.requestId && status[p.requestId] && (
                <span className={`text-label-md ${status[p.requestId].error || status[p.requestId].problems?.length ? 'text-error' : 'text-success'}`}>
                  {status[p.requestId].error ?? `${status[p.requestId].status} · ${status[p.requestId].successfulUpdates?.length ?? 0} ok · ${status[p.requestId].problems?.length ?? 0} problems`}
                </span>
              )}
            </li>
          ))}
          {phase === 'done' && <p className="text-body-sm text-on-surface-variant">Wayfair processes requests in the background; "Check what Wayfair did" reads each outcome. New images land beside the ones Wayfair already holds: once the request completes, remove the old set in Partner Home (Variant Media) and confirm the lead there with "Use as Lead" if the white main is not it.</p>}
        </ol>
      )}
    </Dialog>
  );
}
