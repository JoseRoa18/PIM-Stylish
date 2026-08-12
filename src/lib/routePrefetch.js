// Hover-prefetch for the lazy routes — the SPA equivalent of speculation
// rules. One import thunk per route, shared by App.jsx's lazy() AND the
// prefetch calls, so both resolve the same module promise: hovering a link
// starts downloading that route's chunk, and the later click finds it done.
// import() dedupes internally, so calling this on every pointerenter is free
// after the first.

export const ROUTE_IMPORTS = {
  dashboard: () => import('@/pages/Dashboard'),
  catalog: () => import('@/pages/Catalog'),
  productDetail: () => import('@/pages/ProductDetail'),
  syndication: () => import('@/pages/Syndication'),
  syndicationChannel: () => import('@/pages/SyndicationChannel'),
  templates: () => import('@/pages/Templates'),
  listingHealth: () => import('@/pages/ListingHealth'),
  pricing: () => import('@/pages/PricingPage'),
  importProducts: () => import('@/pages/ImportProducts'),
  users: () => import('@/features/users/pages/Users'),
  activity: () => import('@/pages/Activity'),
  comingSoon: () => import('@/pages/ComingSoon'),
};

/** Best effort: a failed prefetch changes nothing — the click loads as today. */
export function prefetchRoute(name) {
  ROUTE_IMPORTS[name]?.().catch(() => {});
}
