import Avatar from '@/components/ui/Avatar';
import { useAuth } from '@/features/auth/AuthContext';
import { usePresence } from '@/features/presence/hooks/usePresence';

const MAX_FACES = 5;

/**
 * Subtle topbar stack of teammates connected right now (Realtime presence).
 * Faces only — the name lives in the hover tooltip; a green dot marks them
 * as live. You never see yourself, so the stack is empty when working alone.
 */
export default function PresenceStack() {
  const { user } = useAuth();
  const online = usePresence();
  const others = online.filter((u) => u.id !== user?.id);
  if (others.length === 0) return null;

  const shown = others.slice(0, MAX_FACES);
  return (
    // Soft pill so the stack reads as one deliberate element instead of a
    // face floating between the search bar and the controls.
    <div
      className="hidden sm:flex items-center -space-x-2 p-1 mr-1 rounded-full bg-surface-container-low"
      aria-label={`${others.length} teammate${others.length === 1 ? '' : 's'} working right now`}
    >
      {shown.map((u) => (
        <span
          key={u.id}
          className="relative inline-flex rounded-full ring-2 ring-surface-container-low"
          title={`${u.name || u.email || 'Teammate'} · working right now`}
        >
          <Avatar name={u.name} email={u.email} src={u.avatar_url} size="sm" />
          <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-success ring-2 ring-surface-container-low" />
        </span>
      ))}
      {others.length > MAX_FACES && (
        <span className="relative inline-flex items-center justify-center w-8 h-8 rounded-full ring-2 ring-surface-container-low bg-surface-container-high text-on-surface-variant text-label-sm font-medium">
          +{others.length - MAX_FACES}
        </span>
      )}
    </div>
  );
}
