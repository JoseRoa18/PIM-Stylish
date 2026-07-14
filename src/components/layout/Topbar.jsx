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
import { useProductSearch } from '@/features/search/hooks/useProductSearch';
import { getThumbnailUrl } from '@/features/media/api/media';
import { formatCategory } from '@/lib/format';

export default function Topbar({ onMenuClick }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  const { results, loading, error } = useProductSearch(query);

  const trimmed = query.trim();
  const showDropdown = isOpen && trimmed.length > 0;
  const showResults = showDropdown && results.length > 0;
  const showError = showDropdown && !loading && Boolean(error);
  const showEmpty = showDropdown && !loading && !error && results.length === 0;
  const showLoadingOnly = showDropdown && loading && results.length === 0;

  // Reset highlight when results change
  useEffect(() => {
    setActiveIndex(-1);
  }, [results]);

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
    navigate(`/catalog/${encodeURIComponent(product.sku)}`);
    closeAndReset();
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
    if (!showDropdown) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const max = results.length - 1;
      // -1 = nothing; cycle: -1 → 0 → 1 → ... → max → -1
      setActiveIndex((i) => (i >= max ? -1 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const max = results.length - 1;
      setActiveIndex((i) => (i <= -1 ? max : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) {
        goToProduct(results[activeIndex]);
      } else if (trimmed) {
        goToCatalog(trimmed);
      }
    }
  }

  // Initials from email (first letter)
  const initial = user?.email?.charAt(0).toUpperCase() ?? '?';

  return (
    <header className="sticky top-0 z-30 h-16 flex justify-between items-center px-4 sm:px-6 bg-surface border-b border-outline-variant gap-2">
      {/* Mobile menu toggle */}
      <button
        type="button"
        onClick={onMenuClick}
        className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-high transition-colors lg:hidden flex-shrink-0"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Search */}
      <div ref={wrapperRef} className="flex items-center flex-1 max-w-xl relative">
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
            onFocus={() => trimmed && setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search by SKU or product name…"
            aria-label="Search products"
            aria-autocomplete="list"
            aria-expanded={showDropdown}
            className="w-full pl-10 pr-20 py-2 bg-surface-container border border-outline-variant rounded-full text-body-md placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
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
                ⌘K
              </kbd>
            )}
          </div>
        </div>

        {showDropdown && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full mt-2 rounded-2xl border border-outline-variant bg-surface shadow-lg overflow-hidden z-40 animate-menu-in"
          >
            {showLoadingOnly && (
              <div className="px-4 py-6 text-center text-body-sm text-on-surface-variant">
                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                Searching…
              </div>
            )}

            {showError && (
              <div className="px-4 py-5 text-center">
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
                <ul className="max-h-[28rem] overflow-y-auto py-1">
                  {results.map((p, i) => (
                    <li key={p.sku} role="option" aria-selected={i === activeIndex}>
                      <button
                        type="button"
                        onClick={() => goToProduct(p)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          i === activeIndex
                            ? 'bg-surface-container-low'
                            : 'hover:bg-surface-container-low/60'
                        }`}
                      >
                        <ProductThumb product={p} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-body-md text-on-surface font-medium truncate">
                              <HighlightedText text={p.model_name || `SKU ${p.sku}`} query={trimmed} />
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-body-sm text-on-surface-variant mt-0.5">
                            <span className="font-mono">
                              <HighlightedText text={p.sku} query={trimmed} />
                            </span>
                            {p.brand && <span>· {p.brand}</span>}
                            {p.category && <span>· {formatCategory(p.category)}</span>}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
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
      </div>

      {/* Right side: user */}
      <div className="flex items-center gap-2 ml-6">
        <ThemeToggle />
        <div className="flex items-center gap-2 p-1 pr-3 rounded-full">
          <div className="w-8 h-8 rounded-full bg-primary text-on-primary font-semibold flex items-center justify-center text-sm">
            {initial}
          </div>
          <span className="text-label-md text-on-surface hidden sm:inline">{user?.email}</span>
        </div>

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
