import { lazy, Suspense } from 'react';
import { Routes, Route, Outlet, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import ProtectedRoute from './features/auth/components/ProtectedRoute';
import RequireRole from './features/auth/components/RequireRole';
import { ConfirmProvider } from './components/ui/ConfirmProvider';
import AppShell from './components/layout/AppShell';
import Login from './features/auth/pages/Login';

// Route-level code splitting: each page (and its heavy deps like TipTap or
// JSZip) loads on demand instead of inflating the initial bundle. The thunks
// live in routePrefetch so hovering a link can start the same download early.
import { ROUTE_IMPORTS } from './lib/routePrefetch';

const Dashboard = lazy(ROUTE_IMPORTS.dashboard);
const Catalog = lazy(ROUTE_IMPORTS.catalog);
const ProductDetail = lazy(ROUTE_IMPORTS.productDetail);
const Syndication = lazy(ROUTE_IMPORTS.syndication);
const SyndicationChannel = lazy(ROUTE_IMPORTS.syndicationChannel);
const Templates = lazy(ROUTE_IMPORTS.templates);
const ListingHealth = lazy(ROUTE_IMPORTS.listingHealth);
const ImportProducts = lazy(ROUTE_IMPORTS.importProducts);
const Users = lazy(ROUTE_IMPORTS.users);
const Activity = lazy(ROUTE_IMPORTS.activity);
const ComingSoon = lazy(ROUTE_IMPORTS.comingSoon);

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24 text-on-surface-variant">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>
  );
}

function ProtectedLayout() {
  // Keyed by pathname so navigating to a not-yet-downloaded chunk shows the
  // fallback right away instead of keeping the previous page on screen
  // (React would otherwise hold the old content during the lazy transition).
  const { pathname } = useLocation();
  return (
    <ProtectedRoute>
      <AppShell>
        <Suspense key={pathname} fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <ConfirmProvider>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes — wrapped in AppShell (sidebar + topbar) */}
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/catalog/:sku" element={<ProductDetail />} />
          <Route path="/syndication" element={<Syndication />} />
          <Route path="/syndication/:channel" element={<SyndicationChannel />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/listing-health" element={<ListingHealth />} />
          <Route
            path="/import"
            element={
              <RequireRole allowed={['admin', 'editor']}>
                <ImportProducts />
              </RequireRole>
            }
          />
          <Route
            path="/users"
            element={
              <RequireRole allowed={['admin']}>
                <Users />
              </RequireRole>
            }
          />
          <Route
            path="/activity"
            element={
              <RequireRole allowed={['admin']}>
                <Activity />
              </RequireRole>
            }
          />

          {/* Not built yet — show a friendly "Coming soon" instead of a dead redirect */}
          <Route path="/assets" element={<ComingSoon />} />
          <Route path="/analytics" element={<ComingSoon />} />
          <Route path="/settings" element={<ComingSoon />} />
        </Route>

        {/* Catch-all → redirect to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConfirmProvider>
  );
}
