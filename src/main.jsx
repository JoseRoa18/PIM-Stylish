import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/features/auth/AuthContext';
import App from './App.jsx';
import ErrorBoundary from './components/ui/ErrorBoundary';
import './index.css';

// A tab opened before a deploy still points at chunk files the new build no
// longer ships ("Failed to fetch dynamically imported module …"). Reload to
// pick up the current build instead of failing the action — at most once
// every 30 s per page, so a file that is really missing can't loop. When it
// does not reload, the import must fail with its own error: a prevented
// preload error resolves the import to nothing, and the action then broke
// with "Cannot read properties of undefined" (Wayfair Promo MAP, 2026-10-16,
// in a tab whose page had reloaded once for an earlier deploy).
window.addEventListener('vite:preloadError', (event) => {
  const key = 'pim-chunk-reload';
  let last = null;
  try {
    last = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    // storage blocked or an old plain-text value — still worth a reload
  }
  if (last?.href === window.location.href && Date.now() - last.at < 30000) return;
  event.preventDefault();
  try {
    sessionStorage.setItem(key, JSON.stringify({ href: window.location.href, at: Date.now() }));
  } catch {
    // storage blocked — still worth one reload attempt
  }
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Last line of defense: a crash outside a page (shell, login, auth)
        shows a message with Reload instead of a blank window. */}
    <ErrorBoundary fullScreen>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);