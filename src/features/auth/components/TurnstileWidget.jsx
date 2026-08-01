import { useEffect, useRef } from 'react';

// Loaded once per page; Turnstile's api.js is safe to share across renders.
let scriptPromise = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the verification widget.'));
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Cloudflare Turnstile widget for the login form. Rendered only when
 * VITE_TURNSTILE_SITE_KEY is configured (see Login.jsx); calls onToken with
 * each fresh token and with null when the token expires. `resetSignal` forces
 * a re-challenge — bump it after a failed sign-in, tokens are single-use.
 */
export default function TurnstileWidget({ siteKey, onToken, resetSignal = 0 }) {
  const holderRef = useRef(null);
  const widgetIdRef = useRef(null);
  // Latest-callback ref so the widget (rendered once) never holds a stale
  // onToken; synced in an effect because refs must not be written in render.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(() => {
      if (cancelled || !holderRef.current || widgetIdRef.current !== null) return;
      widgetIdRef.current = window.turnstile.render(holderRef.current, {
        sitekey: siteKey,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        callback: (token) => onTokenRef.current?.(token),
        'expired-callback': () => onTokenRef.current?.(null),
      });
    }).catch(() => {
      // Widget failed to load (offline/CSP): leave the form usable; the
      // server-side captcha check is what actually enforces it.
    });
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current !== null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      onTokenRef.current?.(null);
    }
  }, [resetSignal]);

  return <div ref={holderRef} className="flex justify-center" />;
}
