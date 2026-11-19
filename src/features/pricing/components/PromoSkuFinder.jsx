import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useProductSearch } from '@/features/search/hooks/useProductSearch';

// The calendar's SKU box (user, 2026-11-19: "un filtro para buscar en qué
// promociones un SKU fue ingresado … no sé cómo identificarlos entre tantas
// promociones"). The top bar's own product search — by SKU, name or a
// marketplace's id — as a combobox: picking a product is the filter. The list
// is drawn outside the calendar's card, at a fixed place: the card clips what
// leaves it and, being a container, holds a fixed box inside itself. It goes
// into <main>, not <body>, so it stays inside a landmark (axe `region`).

const LIMIT = 6;
const listHome = () => document.getElementById('main-content') ?? document.body;
const holds = (text, typed) => String(text ?? '').toLowerCase().includes(typed.toLowerCase());

/**
 * @param value    the product the calendar is filtered by ({ sku, name }), or null
 * @param busy     its promotions are being read
 * @param onPick   ({ sku, name }) => void
 * @param onClear  () => void
 */
export default function PromoSkuFinder({ value, busy = false, onPick, onClear }) {
  const listId = useId();
  const input = useRef(null);
  const applied = value?.sku ?? '';
  const [text, setText] = useState(applied);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState(null);

  // The filter changed from outside (Clear, "Show everything"): the box says what is applied.
  const [seen, setSeen] = useState(applied);
  if (seen !== applied) {
    setSeen(applied);
    setText(applied);
  }

  const typed = text.trim();
  // Nothing is looked up for the SKU that is already the filter.
  const searching = open && typed !== '' && typed.toLowerCase() !== applied.toLowerCase();
  const { results, loading, error } = useProductSearch(searching ? typed : '', { limit: LIMIT });

  const [lastResults, setLastResults] = useState(results);
  if (lastResults !== results) {
    setLastResults(results);
    setActive(-1);
  }

  // Under the box, kept inside the window (a phone: nearly its whole width).
  useEffect(() => {
    if (!searching) return undefined;
    const put = () => {
      const r = input.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 352), window.innerWidth - 24);
      setPlace({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), width });
    };
    put();
    window.addEventListener('resize', put);
    window.addEventListener('scroll', put, true);
    return () => {
      window.removeEventListener('resize', put);
      window.removeEventListener('scroll', put, true);
    };
  }, [searching]);

  function pick(product) {
    setOpen(false);
    setActive(-1);
    setText(product.sku);
    onPick({ sku: product.sku, name: product.model_name ?? '' });
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      // Back to what is applied; the key goes no further only while the list is open.
      if (searching) e.stopPropagation();
      setOpen(false);
      setText(applied);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!searching) return;
      const exact = results.find((p) => p.sku.toLowerCase() === typed.toLowerCase());
      const choice = active >= 0 ? results[active] : exact ?? (loading ? null : results[0]);
      if (choice) pick(choice);
      return;
    }
    if (!searching || !results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i >= results.length - 1 ? 0 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
    }
  }

  const listed = searching && Boolean(place);
  const hasOptions = listed && results.length > 0;

  return (
    <div className="relative">
      <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
      <input
        ref={input}
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          // The box emptied by hand takes the filter off, like its ×.
          if (!e.target.value.trim() && applied) onClear();
        }}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        onBlur={() => {
          setOpen(false);
          setText(applied);
        }}
        onKeyDown={onKeyDown}
        placeholder="Find a SKU…"
        role="combobox"
        aria-label="Show only the promotions of one SKU"
        aria-autocomplete="list"
        aria-expanded={hasOptions}
        aria-controls={hasOptions ? listId : undefined}
        aria-activedescendant={hasOptions && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="search"
        className={cn(
          'w-44 pl-8 pr-8 py-[0.4rem] rounded-full border text-body-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 transition-colors',
          applied ? 'border-primary bg-primary-container/30 font-medium' : 'border-outline-variant bg-surface hover:bg-surface-container-low',
        )}
      />
      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center text-on-surface-variant">
        {(busy || (searching && loading)) ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />
        ) : text && (
          <button
            type="button"
            onClick={() => {
              if (applied) onClear();
              setText('');
              input.current?.focus();
            }}
            aria-label={applied ? `Stop filtering by ${applied}` : 'Clear the SKU box'}
            title={applied ? 'Show every promotion again' : 'Clear'}
            className="p-[5px] rounded-full hover:bg-surface-container-high hover:text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </span>

      {listed && createPortal(
        // A press inside never takes the focus from the box, so a click on an option is not a blur first.
        <div
          style={{ position: 'fixed', top: place.top, left: place.left, width: place.width }}
          className="z-50 rounded-2xl border border-outline-variant bg-surface shadow-lg overflow-hidden animate-menu-in"
          onMouseDown={(e) => e.preventDefault()}
        >
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Products" className="py-1">
              {results.map((p, i) => (
                <li key={p.sku} role="presentation">
                  <button
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onClick={() => pick(p)}
                    onMouseEnter={() => setActive(i)}
                    className={cn('w-full flex items-baseline gap-2.5 px-4 py-2 text-left transition-colors', i === active ? 'bg-secondary-container/60' : 'hover:bg-surface-container')}
                  >
                    <span className="flex-shrink-0 text-body-md text-on-surface font-medium">{p.sku}</span>
                    <span className="min-w-0 truncate text-body-sm text-on-surface-variant">
                      {p.model_name}
                      {/* The marketplace's id that found it, only when neither its SKU nor its name did. */}
                      {p.matched_alias && !holds(p.sku, typed) && !holds(p.model_name, typed) && <>{p.model_name ? ' · ' : ''}{p.matched_alias.marketplace} {p.matched_alias.alias}</>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : loading ? (
            <p className="px-4 py-3 text-body-sm text-on-surface-variant">Searching…</p>
          ) : error ? (
            <p role="alert" className="px-4 py-3 text-body-sm text-error [overflow-wrap:anywhere]">The search failed: {error.message ?? String(error)}</p>
          ) : (
            <p role="status" className="px-4 py-3 text-body-sm text-on-surface-variant">No product matches <span className="text-on-surface font-medium">“{typed}”</span>.</p>
          )}
        </div>,
        listHome(),
      )}
    </div>
  );
}
