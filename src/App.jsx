import { lazy, Suspense } from 'react';
import { Routes, Route, Outlet, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider } from './features/auth/AuthContext';
import ProtectedRoute from './features/auth/components/ProtectedRoute';
import { ConfirmProvider } from './components/ui/ConfirmProvider';
import AppShell from './components/layout/AppShell';
import Login from './features/auth/pages/Login';

// Route-level code splitting: each page (and its heavy deps like TipTap or
// JSZip) loads on demand instead of inflating the initial bundle.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Catalog = lazy(() => import('./pages/Catalog'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const Syndication = lazy(() => import('./pages/Syndication'));
const Templates = lazy(() => import('./pages/Templates'));
const ListingHealth = lazy(() => import('./pages/ListingHealth'));
const ImportProducts = lazy(() => import('./pages/ImportProducts'));

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24 text-on-surface-variant">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>
  );
}

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <AuthProvider>
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
            <Route path="/templates" element={<Templates />} />
            <Route path="/listing-health" element={<ListingHealth />} />
            <Route path="/import" element={<ImportProducts />} />
          </Route>

          {/* Catch-all → redirect to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ConfirmProvider>
    </AuthProvider>
  );
}
