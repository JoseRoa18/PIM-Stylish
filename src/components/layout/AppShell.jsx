import { useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

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

    const lenis = new Lenis({ wrapper, content, duration: 1.1, smoothWheel: true });

    let rafId;
    const raf = (time) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
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
