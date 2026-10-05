import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Menu,
  LogOut,
  X,
  Loader2,
  ArrowRight,
  Package,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import ThemeToggle from '@/components/ui/ThemeToggle';
import AccountMenu from '@/components/layout/AccountMenu';
import PresenceStack from '@/components/layout/PresenceStack';
import { useProductSearch } from '@/features/search/hooks/useProductSearch';
import { readRecent, rememberRecent, forgetRecent, clearRecent } from '@/features/search/lib/recentSearches';
import { prefetchRoute } from '@/lib/routePrefetch';
import { getThumbnailUrl, preloadImage, thumbFallback } from '@/features/media/api/media';
import { prefetchProductMedia } from '@/features/media/hooks/useProductMedia';
import { formatCategory } from '@/lib/format';

const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

export default function Topbar({ onMenuClick, menuOpen = false }) {
  const { signOut, user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();

  // The products opened from this search, shown when the empty bar is
  // clicked (recentSearches.js). Re-read when the signed-in user changes —
  // adjusted during render, like the highlight reset below.
  const [recent, setRecent] = useState(() => readRecent(userId));
  const [recentFor, setRecentFor] = useState(userId);
  if (recentFor !== userId) {
    setRecentFor(userId);
    setRecent(readRecent(userId));
  }

  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );

  // Short placeholder on phones — the full one clips to a single letter.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = (e) => setCompact(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  const { results, loading, error } = useProductSearch(query);

  const trimmed = query.trim();
  const showDropdown = isOpen && trimmed.length > 0;
  const showResults = showDropdown && results.length > 0;
  const showError = showDropdown && !loading && Boolean(error);
  const showEmpty = showDropdown && !loading && !error && results.length === 0;
  const showLoadingOnly = showDropdown && loading && results.length === 0;
  // The empty bar, opened: the recently opened products.
  const showRecent = isOpen && !trimmed && recent.length > 0;
  const options = showRecent ? recent : results;

  // Reset highlight when results change — adjusted during render instead of
  // in an effect so it doesn't trigger a second render pass after commit.
  const [prevResults, setPrevResults] = useState(results);
  if (prevResults !== results) {
    setPrevResults(results);
    setActiveIndex(-1);
  }

  // Click-outside closes the dropdown
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Global keyboard shortcut: Ctrl/Cmd+K focuses the search
  useEffect(() => {
    function onKey(e) {
      const isShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isShortcut) {
        // Not while a modal is open: focus must stay inside it.
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setIsOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function handleSignOut() {
    try {
      await signOut();
    } catch (err) {
      console.error('Sign out failed:', err);
    }
  }

  function goToProduct(product) {
    setRecent(rememberRecent(userId, product, recent));
    navigate(`/catalog/${encodeURIComponent(product.sku)}`);
    closeAndReset();
  }

  // A recent entry stores its thumbnail path flat; the rows read primary_image.
  const asProduct = (item) => ({ ...item, primary_image: item.image ? { storage_path: item.image } : null });

  function removeRecent(sku) {
    setRecent(forgetRecent(userId, sku, recent));
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function goToCatalog(searchQuery) {
    navigate(`/catalog?search=${encodeURIComponent(searchQuery.trim())}`);
    closeAndReset();
  }

  function closeAndReset() {
    setIsOpen(false);
    setQuery('');
    setActiveIndex(-1);
    inputRef.current?.blur();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (query) {
        setQuery('');
      } else {
        setIsOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (!showDropdown && !showRecent) return;

    // Delete takes the highlighted product off the recent list (the mouse
    // has the × on each row).
    if (e.key === 'Delete' && showRecent && activeIndex >= 0 && recent[activeIndex]) {
      e.preventDefault();
      const next = forgetRecent(userId, recent[activeIndex].sku, recent);
      setRecent(next);
      setActiveIndex(next.length ? Math.min(activeIndex, next.length - 1) : -1);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const max = options.length - 1;
      // -1 = nothing; cycle: -1 → 0 → 1 → ... → max → -1
      setActiveIndex((i) => (i >= max ? -1 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const max = options.length - 1;
      setActiveIndex((i) => (i <= -1 ? max : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) {
        goToProduct(showRecent ? asProduct(options[activeIndex]) : options[activeIndex]);
      } else if (trimmed) {
        goToCatalog(trimmed);
      }
    }
  }

  return (
    <header className="sticky top-0 z-30 h-16 flex justify-between items-center px-4 sm:px-6 bg-surface border-b border-outline-variant gap-2">
      {/* Mobile menu toggle */}
      <button
        type="button"
        onClick={onMenuClick}
        className="relative p-2 rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors lg:hidden flex-shrink-0 after:absolute after:-inset-1"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        aria-controls="app-sidebar"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Search */}
      <div
        ref={wrapperRef}
        className="flex items-center flex-1 max-w-xl relative"
        // Tabbing out of the search closes its results (relatedTarget is
        // null on a click in Safari — the click-outside handler covers that).
        onBlur={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setIsOpen(false);
        }}
      >
        {/* One live region, always mounted, announces what the panel shows. */}
        <span className="sr-only" role="status">
          {showRecent ? `${recent.length} recent product${recent.length === 1 ? '' : 's'}` : !showDropdown ? '' : loading && !results.length ? 'Searching…' : error ? '' : results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : `No products match ${trimmed}`}
        </span>
        <div className="relative w-full group">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant group-focus-within:text-primary transition-colors pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onClick={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={compact ? 'Search…' : 'Search by SKU, name or marketplace id…'}
            role="combobox"
            aria-label="Search products"
            aria-autocomplete="list"
            aria-expanded={showDropdown || showRecent}
            aria-controls={showResults ? 'global-search-results' : showRecent ? 'global-search-recent' : undefined}
            aria-activedescendant={
              activeIndex < 0 ? undefined
                : showResults ? `global-search-option-${activeIndex}`
                  : showRecent ? `global-search-recent-${activeIndex}` : undefined
            }
            aria-keyshortcuts="Control+K Meta+K"
            className="w-full pl-10 pr-10 sm:pr-20 py-2 bg-surface-container border border-outline-variant rounded-full text-body-md placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
          {/* Right-side affordances inside the input */}
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 text-on-surface-variant">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {query && !loading && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="p-1 rounded-full hover:bg-surface-container-high transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {!query && (
              <kbd
                className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-label-md bg-surface-container-high text-on-surface-variant font-mono"
                aria-hidden
              >
                {IS_MAC ? '⌘K' : 'Ctrl K'}
              </kbd>
            )}
          </div>
        </div>

        {showDropdown && (
          // On phones the input is too narrow to host readable rows, so the
          // panel breaks out to near-full viewport width below the topbar.
          <div
            className="fixed inset-x-3 top-16 sm:absolute sm:inset-x-0 sm:top-full mt-2 rounded-2xl border border-outline-variant bg-surface shadow-lg overflow-hidden z-40 animate-menu-in"
          >
            {showLoadingOnly && (
              <div className="px-4 py-6 text-center text-body-sm text-on-surface-variant">
                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                Searching…
              </div>
            )}

            {showError && (
              <div role="alert" className="px-4 py-5 text-center">
                <p className="text-body-sm text-error font-semibold">Search failed</p>
                <p className="text-body-sm text-on-surface-variant mt-1 break-words">
                  {error.message ?? String(error)}
                </p>
              </div>
            )}

            {showEmpty && (
              <div className="px-4 py-6 text-center">
                <p className="text-body-sm text-on-surface">
                  No products match <span className="font-semibold">"{trimmed}"</span>.
                </p>
                <p className="text-body-sm text-on-surface-variant mt-1">
                  Try a different SKU or product name.
                </p>
              </div>
            )}

            {showResults && (
              <>
                {/* max-h = 6 exact rows (67px each) + py-1, so no row is cut mid-height */}
                <ul id="global-search-results" role="listbox" aria-label="Search results" className="max-h-[25.625rem] overflow-y-auto py-1">
                  {results.map((p, i) => {
                    // Without a model name the title falls back to the SKU, so
                    // repeating it in the subtitle would just be noise.
                    const hasModelName = Boolean(p.model_name);
                    return (
                      <li key={p.sku} role="presentation">
                        {/* The option itself; the input keeps focus and moves
                            through the options with the arrow keys. */}
                        <button
                          id={`global-search-option-${i}`}
                          type="button"
                          role="option"
                          aria-selected={i === activeIndex}
                          tabIndex={-1}
                          onClick={() => goToProduct(p)}
                          onMouseEnter={() => {
                            setActiveIndex(i);
                            prefetchRoute('productDetail');
                            prefetchProductMedia(p.sku);
                            if (p.primary_image?.storage_path) {
                              preloadImage(getThumbnailUrl(p.primary_image.storage_path, 400));
                            }
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                            i === activeIndex
                              ? 'bg-secondary-container/60'
                              : 'hover:bg-surface-container'
                          }`}
                        >
                          <ProductThumb product={p} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="min-w-0 text-body-md text-on-surface font-medium truncate">
                                <HighlightedText text={p.model_name || p.sku} query={trimmed} />
                              </span>
                            </div>
                            {(hasModelName || p.brand || p.category || p.matched_alias) && (
                              <div className="flex items-center gap-2 min-w-0 overflow-hidden whitespace-nowrap text-body-sm text-on-surface-variant mt-0.5">
                                {hasModelName && (
                                  <span className="font-mono shrink-0">
                                    <HighlightedText text={p.sku} query={trimmed} />
                                  </span>
                                )}
                                {p.brand && (
                                  <span className="shrink-0">
                                    {hasModelName && '· '}
                                    {p.brand}
                                  </span>
                                )}
                                {p.category && (
                                  <span className="truncate">
                                    {(hasModelName || p.brand) && '· '}
                                    {formatCategory(p.category)}
                                  </span>
                                )}
                                {p.matched_alias && (
                                  // Found through a marketplace id: say which one.
                                  <span className="shrink-0">
                                    {(hasModelName || p.brand || p.category) && '· '}
                                    {p.matched_alias.marketplace}{' '}
                                    <span className="font-mono"><HighlightedText text={String(p.matched_alias.alias ?? '')} query={trimmed} /></span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button
                  type="button"
                  onClick={() => goToCatalog(trimmed)}
                  className="w-full flex items-center justify-between gap-2 px-4 py-2.5 border-t border-outline-variant bg-surface-container-low/40 hover:bg-surface-container-low text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  <span>View all results for <span className="font-semibold text-on-surface">"{trimmed}"</span></span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )}

        {showRecent && (
          <div className="fixed inset-x-3 top-16 sm:absolute sm:inset-x-0 sm:top-full mt-2 rounded-2xl border border-outline-variant bg-surface shadow-lg overflow-hidden z-40 animate-menu-in">
            <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
              <span id="global-search-recent-label" className="text-label-md text-on-surface-variant">Recent</span>
              <button
                type="button"
                onClick={() => {
                  setRecent(clearRecent(userId));
                  setActiveIndex(-1);
                  inputRef.current?.focus();
                }}
                className="px-2 py-0.5 rounded-full text-label-md text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Clear
              </button>
            </div>
            <span id="global-search-recent-hint" className="sr-only">Press Delete to remove the highlighted product.</span>
            <ul id="global-search-recent" role="listbox" aria-labelledby="global-search-recent-label" aria-describedby="global-search-recent-hint" className="max-h-[25.625rem] overflow-y-auto pb-1">
              {recent.map((item, i) => {
                const p = asProduct(item);
                const hasModelName = Boolean(p.model_name);
                return (
                  <li
                    key={p.sku}
                    role="presentation"
                    className={`flex items-center pr-2 transition-colors ${i === activeIndex ? 'bg-secondary-container/60' : 'hover:bg-surface-container'}`}
                  >
                    <button
                      id={`global-search-recent-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      tabIndex={-1}
                      onClick={() => goToProduct(p)}
                      onMouseEnter={() => {
                        setActiveIndex(i);
                        prefetchRoute('productDetail');
                        prefetchProductMedia(p.sku);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-3 pl-4 pr-2 py-2.5 text-left"
                    >
                      <ProductThumb product={p} />
                      <div className="min-w-0 flex-1">
                        <span className="block text-body-md text-on-surface font-medium truncate">{p.model_name || p.sku}</span>
                        {(hasModelName || p.brand || p.category) && (
                          <span className="block text-body-sm text-on-surface-variant mt-0.5 truncate">
                            {[hasModelName && p.sku, p.brand, p.category && formatCategory(p.category)].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                    </button>
                    {/* Mouse twin of the Delete key: a listbox holds only
                        options, so this stays out of the accessibility tree. */}
                    <button
                      type="button"
                      onClick={() => removeRecent(p.sku)}
                      aria-hidden="true"
                      tabIndex={-1}
                      title="Remove from recent"
                      className="p-1.5 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* Right side: user */}
      <div className="flex items-center gap-2 ml-2 sm:ml-6">
        <PresenceStack />
        <ThemeToggle />
        <AccountMenu />

        <button
          onClick={handleSignOut}
          className="p-2 rounded-full text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-all"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
}

function ProductThumb({ product }) {
  if (product.primary_image?.storage_path) {
    return (
      <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-container-low border border-outline-variant flex-shrink-0">
        <img
          src={getThumbnailUrl(product.primary_image.storage_path, 80)}
          onError={thumbFallback(product.primary_image.storage_path)}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className="w-10 h-10 rounded-lg bg-surface-container-low border border-outline-variant flex items-center justify-center flex-shrink-0 text-on-surface-variant">
      <Package className="w-4 h-4" strokeWidth={1.5} />
    </div>
  );
}

// Wraps occurrences of `query` (case-insensitive) in <mark> for visual emphasis.
function HighlightedText({ text, query }) {
  if (!text) return null;
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!lower.includes(q)) return text;

  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark key={`${idx}-${q}`} className="bg-primary-container text-on-primary-container rounded-sm px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
  }
  return parts;
}
