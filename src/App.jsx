import { Routes, Route, Outlet, Navigate } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthContext';
import ProtectedRoute from './features/auth/components/ProtectedRoute';
import AppShell from './components/layout/AppShell';
import Login from './features/auth/pages/Login';
import Dashboard from './pages/Dashboard';
import Catalog from './pages/Catalog';
import ProductDetail from './pages/ProductDetail';
import Syndication from './pages/Syndication';
import Templates from './pages/Templates';
import ListingHealth from './pages/ListingHealth';

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Outlet />
      </AppShell>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <AuthProvider>
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
        </Route>

        {/* Catch-all → redirect to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}