import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  ChevronDown,
  Check,
  X,
} from 'lucide-react';
import {
  scoreProduct,
  categorizeScore,
  SCORE_CATEGORIES,
} from '../lib/listingHealth';

const CATEGORY_ICONS = {
  excellent: CheckCircle2,
  good: TrendingUp,
  needs_work: Clock,
  critical: XCircle,
};

// Border-only style — keeps the card calm; ring + chip carry the color.
const CATEGORY_BORDERS = {
  excellent: 'border-emerald-200',
  good: 'border-tertiary-container',
  needs_work: 'border-amber-200',
  critical: 'border-error/30',
};

const CATEGORY_HEADER_TINT = {
  excellent: 'bg-emerald-50/60',
  good: 'bg-tertiary-container/20',
  needs_work: 'bg-amber-50/60',
  critical: 'bg-error-container/40',
};

const CATEGORY_CHIP_STYLES = {
  excellent: 'text-emerald-700',
  good: 'text-on-tertiary-container',
  needs_work: 'text-amber-700',
  critical: 'text-error',
};

const SCORE_RING_COLORS = {
  excellent: 'text-emerald-500',
  good: 'text-tertiary',
  needs_work: 'text-amber-500',
  critical: 'text-error',
};

const SEVERITY_LABEL = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
};

const SEVERITY_DOT = {
  critical: 'bg-error',
  major: 'bg-amber-500',
  minor: 'bg-on-surface-variant',
};

export default function ProductHealthBadge({ product, media, overrides }) {
  const [expanded, setExpanded] = useState(false);

  // When overrides are provided (e.g. live Wix data from the marketplace card),
  // merge them on top of the PIM product so the score reflects what the
  // marketplace actually has, not just what's in the PIM.
  const effectiveProduct = useMemo(
    () => (overrides ? { ...product, ...overrides } : product),
    [product, overrides],
  );

  const result = useMemo(
    () => scoreProduct(effectiveProduct, media),
    [effectiveProduct, media],
  );
  const category = categorizeScore(result.score);
  const Icon = CATEGORY_ICONS[category];
  const failedCount = result.issues.length;

  // Group issues by category for cleaner display
  const issuesByCategory = useMemo(() => {
    const out = {};
    for (const i of result.issues) {
      if (!out[i.category]) out[i.category] = [];
      out[i.category].push(i);
    }
    return out;
  }, [result.issues]);

  const passedByCategory = useMemo(() => {
    const out = {};
    for (const p of result.passed) {
      if (!out[p.category]) out[p.category] = [];
      out[p.category].push(p);
    }
    return out;
  }, [result.passed]);

  const allCategories = [...new Set([
    ...Object.keys(issuesByCategory),
    ...Object.keys(passedByCategory),
  ])];

  return (
    <div className={`rounded-xl border ${CATEGORY_BORDERS[category]} bg-surface overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-black/[0.02] transition-colors text-left ${CATEGORY_HEADER_TINT[category]}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ScoreRing score={result.score} colorClass={SCORE_RING_COLORS[category]} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-body-md font-semibold text-on-surface">
                Listing Health
              </span>
              <span className={`inline-flex items-center gap-1 text-label-md font-medium ${CATEGORY_CHIP_STYLES[category]}`}>
                <Icon className="w-3.5 h-3.5" />
                {SCORE_CATEGORIES[category].label}
              </span>
            </div>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              {failedCount === 0
                ? 'All checks passed.'
                : `${failedCount} ${failedCount === 1 ? 'check' : 'checks'} not met`}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-on-surface-variant flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-outline-variant">
          {allCategories.map((cat) => {
            const failed = issuesByCategory[cat] ?? [];
            const passed = passedByCategory[cat] ?? [];
            return (
              <div key={cat}>
                <div className="text-label-md font-semibold text-on-surface mt-3 mb-1.5">
                  {cat}
                </div>
                <ul className="space-y-1">
                  {failed.map((i) => (
                    <li key={i.key} className="flex items-center justify-between gap-2 text-body-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <X className="w-3.5 h-3.5 text-error flex-shrink-0" />
                        <span className="text-on-surface">{i.label}</span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-label-md whitespace-nowrap">
                        <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[i.severity]}`} />
                        {SEVERITY_LABEL[i.severity]}
                      </span>
                    </li>
                  ))}
                  {passed.map((p) => (
                    <li key={p.key} className="flex items-center gap-2 text-body-sm">
                      <Check className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                      <span className="text-on-surface-variant">{p.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScoreRing({ score, colorClass }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative w-12 h-12 flex-shrink-0">
      <svg className="w-12 h-12 -rotate-90" viewBox="0 0 44 44">
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-outline-variant opacity-40"
        />
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={colorClass}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-label-md font-bold text-on-surface">
        {score}
      </div>
    </div>
  );
}
