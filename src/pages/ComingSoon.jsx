import { Link, useLocation } from 'react-router-dom';
import { Hammer, ArrowLeft } from 'lucide-react';

// Friendly placeholder for nav destinations that aren't built yet
// (Assets, Analytics, Settings). The feature name is derived from the path.
function titleFromPath(pathname) {
  const seg = pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'This page';
  return seg
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function ComingSoon() {
  const { pathname } = useLocation();
  const title = titleFromPath(pathname);

  return (
    <div className="max-w-2xl mx-auto px-6 py-24 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary-container/50 flex items-center justify-center mx-auto mb-5">
        <Hammer className="w-7 h-7 text-primary" />
      </div>
      <h1 className="text-headline-md text-on-surface">{title}</h1>
      <p className="text-title-md text-primary mt-1">Coming soon</p>
      <p className="text-body-md text-on-surface-variant mt-3">
        We're still building this section. It'll show up here once it's ready.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-2 mt-8 px-4 py-2 rounded-full border border-outline-variant text-label-md text-on-surface hover:bg-surface-container-low transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>
    </div>
  );
}
