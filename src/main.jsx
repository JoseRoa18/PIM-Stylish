import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/features/auth/AuthContext';
import App from './App.jsx';
import './index.css';

// A tab opened before a deploy still points at chunk files the new build no
// longer ships ("Failed to fetch dynamically imported module …"). Reload
// once to pick up the current build instead of failing the action.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const key = 'pim-chunk-reload';
  try {
    if (sessionStorage.getItem(key) === window.location.href) return;
    sessionStorage.setItem(key, window.location.href);
  } catch {
    // storage blocked — still worth one reload attempt
  }
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);