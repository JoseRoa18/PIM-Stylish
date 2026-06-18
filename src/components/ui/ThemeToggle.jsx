import { useState } from 'react';
import { Sun, Moon } from 'lucide-react';

function prefersDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * Light/dark toggle. The initial theme is applied pre-paint by the inline
 * script in index.html (reads localStorage, falls back to OS preference);
 * this button flips it and persists an explicit choice.
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(prefersDark);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch (e) {
      /* ignore storage failures (private mode, etc.) */
    }
    setDark(next);
  }

  return (
    <button
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
