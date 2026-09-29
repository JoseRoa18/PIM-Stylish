import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

// The reminders appear seconds after load at the earliest, so their code
// (and the promotion helpers they use) stays out of the first download
// (performance pass 2026-09-29).
const PromoNudge = lazy(() => import('./PromoNudge'));
const PromoTaskNudge = lazy(() => import('./PromoTaskNudge'));

export default function AppShell({ children }) {
  // On <lg screens the sidebar becomes an overlay drawer toggled from the Topbar.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mainRef = useRef(null);
  const contentRef = useRef(null);

  // Momentum (inertia) scrolling on the main content area. The scroll
  // container is <main>, not the window, so Lenis is bound to it explicitly.
  // Skipped entirely for users who prefer reduced motion — they keep native
  // scrolling. Inner scroll areas opt out via `data-lenis-prevent`.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const wrapper = mainRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    // Lenis loads after the first paint — native scrolling works meanwhile.
    let lenis = null;
    let rafId;
    let cancelled = false;
    import('lenis').then(({ default: Lenis }) => {
      if (cancelled) return;
      lenis = new Lenis({ wrapper, content, duration: 1.1, smoothWheel: true });
      const raf = (time) => {
        lenis.raf(time);
        rafId = requestAnimationFrame(raf);
      };
      rafId = requestAnimationFrame(raf);
    }).catch(() => { /* smooth scrolling is optional */ });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      lenis?.destroy();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <Suspense fallback={null}>
        <PromoNudge />
        <PromoTaskNudge />
      </Suspense>
      <div className="lg:ml-64 h-screen flex flex-col">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div ref={contentRef} className="max-w-[1400px] mx-auto px-4 sm:px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
