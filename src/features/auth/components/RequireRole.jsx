import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';

/**
 * Route guard that requires the current user to hold one of `allowed` roles.
 * Assumes it renders inside ProtectedRoute (session already guaranteed); it
 * only checks the role. Falls back to the dashboard when the role is missing.
 */
export default function RequireRole({ allowed, children }) {
  const { role, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-on-surface-variant text-sm">
        Cargando…
      </div>
    );
  }

  if (!allowed.includes(role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
