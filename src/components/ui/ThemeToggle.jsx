import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Sun, Moon } from 'lucide-react';

function prefersDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * Light/dark toggle. The initial theme is applied pre-paint by the inline
 * script in index.html (reads localStorage, falls back to OS preference);
 * this button flips it and persists an explicit choice.
 *
 * The flip is wrapped in the View Transitions API when available: the new
 * theme reveals as a circle growing from this button (see the
 * ::view-transition rules in index.css). Browsers without support — and
 * users with prefers-reduced-motion — get the instant switch instead.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(prefersDark);
  const btnRef = useRef(null);

  function toggle() {
    const next = !dark;
    const apply = () => {
      document.documentElement.classList.toggle('dark', next);
      try {
        localStorage.setItem('theme', next ? 'dark' : 'light');
      } catch (e) {
        /* ignore storage failures (private mode, etc.) */
      }
      setDark(next);
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduceMotion) {
      apply();
      return;
    }

    // Reveal from the button's center; radius must reach the farthest corner.
    const rect = btnRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );
    const root = document.documentElement.style;
    root.setProperty('--theme-x', `${x}px`);
    root.setProperty('--theme-y', `${y}px`);
    root.setProperty('--theme-r', `${radius}px`);

    // flushSync so the icon swap is captured in the transition snapshot.
    document.startViewTransition(() => flushSync(apply));
  }

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
    >
      {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
