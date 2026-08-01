import { useState } from 'react';
import {
  Users as UsersIcon,
  UserPlus,
  Loader2,
  KeyRound,
  Trash2,
  AlertCircle,
  Copy,
  Check,
  X,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import Avatar from '@/components/ui/Avatar';
import { useUsers } from '../hooks/useUsers';
import { updateUserRole, resetUserPassword, deleteUser } from '../api/users';
import { generatePassword } from '../password';
import { ROLE_OPTIONS, ROLE_BADGE, ROLE_LABELS } from '../roles';
import AddUserDialog from '../components/AddUserDialog';

export default function Users() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const { users, loading, error, reload } = useUsers();

  const [showAdd, setShowAdd] = useState(false);
  const [created, setCreated] = useState(null); // { email, password } banner
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function handleRoleChange(u, role) {
    if (role === u.role) return;
    setActionError(null);
    setBusyId(u.id);
    try {
      await updateUserRole(u.id, role);
      await reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReset(u) {
    const ok = await confirm({
      title: `Reset password for ${u.email}?`,
      message: 'A new temporary password will be generated and shown once. Share it with the user.',
      confirmLabel: 'Reset password',
    });
    if (!ok) return;

    const password = generatePassword();
    setActionError(null);
    setBusyId(u.id);
    try {
      await resetUserPassword(u.id, password);
      setCreated({ email: u.email, password });
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(u) {
    const ok = await confirm({
      title: `Remove ${u.email}?`,
      message: 'This permanently deletes their account and access. This cannot be undone.',
      confirmLabel: 'Remove user',
      destructive: true,
    });
    if (!ok) return;

    setActionError(null);
    setBusyId(u.id);
    try {
      await deleteUser(u.id);
      await reload();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header — same icon-tile pattern as the Activity Log page. */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-container/50 flex items-center justify-center flex-shrink-0">
            <UsersIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-headline-sm text-on-surface">Users</h1>
            <p className="text-body-sm text-on-surface-variant mt-0.5">
              Manage who has access to the PIM and what they can do.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold flex items-center gap-2 hover:opacity-90 transition-opacity flex-shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          Add team member
        </button>
      </div>

      {/* Just-created / reset credentials banner */}
      {created && (
        <CredentialsBanner
          email={created.email}
          password={created.password}
          onDismiss={() => setCreated(null)}
        />
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-error-container/40 border border-error/30 flex items-start gap-2 animate-banner-in">
          <AlertCircle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" />
          <p className="text-body-sm text-error">{actionError}</p>
        </div>
      )}

      {/* Table */}
      <div className="bg-surface border border-outline-variant rounded-2xl overflow-x-auto">
        {loading ? (
          <div className="py-16 flex items-center justify-center text-on-surface-variant text-body-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading users…
          </div>
        ) : error ? (
          <div className="py-16 text-center">
            <p className="text-body-md text-error font-semibold">Couldn’t load users</p>
            <p className="text-body-sm text-on-surface-variant mt-1">{error.message}</p>
            <button
              onClick={reload}
              className="mt-3 px-4 py-1.5 rounded-full border border-outline-variant text-body-sm hover:bg-surface-container-low"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Phones: stacked cards — the table would clip its role selects
                and push Actions off-screen at narrow widths. */}
            <ul className="sm:hidden divide-y divide-outline-variant">
              {users.map((u) => {
                const isMe = u.id === me?.id;
                const busy = busyId === u.id;
                return (
                  <li key={u.id} className="p-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={u.full_name} email={u.email} src={u.avatar_url} />
                      <div className="min-w-0 flex-1">
                        <div className="text-body-md text-on-surface truncate">
                          {u.full_name || nameFromEmail(u.email) || '—'}
                          {isMe && (
                            <span className="ml-2 text-label-sm text-on-surface-variant">(you)</span>
                          )}
                        </div>
                        <div className="text-body-sm text-on-surface-variant truncate">
                          {u.email}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-3">
                      <RoleControl user={u} isMe={isMe} busy={busy} onChange={handleRoleChange} />
                      <RowActions
                        user={u}
                        isMe={isMe}
                        busy={busy}
                        onReset={handleReset}
                        onDelete={handleDelete}
                      />
                    </div>
                    <p className="text-label-sm text-on-surface-variant mt-2">
                      Last sign-in: {formatDate(u.last_sign_in_at)}
                    </p>
                  </li>
                );
              })}
            </ul>

            <table className="w-full min-w-[560px] text-left hidden sm:table">
              <thead>
                <tr className="border-b border-outline-variant text-label-md text-on-surface-variant">
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Last sign-in</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isMe = u.id === me?.id;
                  const busy = busyId === u.id;
                  return (
                    <tr key={u.id} className="border-b border-outline-variant last:border-0">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.full_name} email={u.email} src={u.avatar_url} />
                          <div className="min-w-0">
                            <div className="text-body-md text-on-surface truncate">
                              {u.full_name || nameFromEmail(u.email) || '—'}
                              {isMe && (
                                <span className="ml-2 text-label-sm text-on-surface-variant">(you)</span>
                              )}
                            </div>
                            <div className="text-body-sm text-on-surface-variant truncate">
                              {u.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <RoleControl user={u} isMe={isMe} busy={busy} onChange={handleRoleChange} />
                      </td>
                      <td className="px-5 py-3 text-body-sm text-on-surface-variant">
                        {formatDate(u.last_sign_in_at)}
                      </td>
                      <td className="px-5 py-3">
                        <RowActions
                          user={u}
                          isMe={isMe}
                          busy={busy}
                          onReset={handleReset}
                          onDelete={handleDelete}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {showAdd && (
        <AddUserDialog
          onClose={() => setShowAdd(false)}
          onCreated={(creds) => {
            setShowAdd(false);
            setCreated(creds);
            reload();
          }}
        />
      )}
    </div>
  );
}

// Your own role is fixed (you can't demote yourself); everyone else gets a select.
function RoleControl({ user, isMe, busy, onChange }) {
  if (isMe) {
    return (
      <span
        className={`inline-flex px-2.5 py-1 rounded-full text-label-sm font-medium ${ROLE_BADGE[user.role]}`}
      >
        {ROLE_LABELS[user.role]}
      </span>
    );
  }
  return (
    <select
      value={user.role}
      disabled={busy}
      onChange={(e) => onChange(user, e.target.value)}
      className="px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
    >
      {ROLE_OPTIONS.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

function RowActions({ user, isMe, busy, onReset, onDelete }) {
  return (
    <div className="flex items-center justify-end gap-1">
      {busy && <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant mr-1" />}
      <button
        onClick={() => onReset(user)}
        disabled={busy}
        title="Reset password"
        className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors disabled:opacity-50"
      >
        <KeyRound className="w-4 h-4" />
      </button>
      <button
        onClick={() => onDelete(user)}
        disabled={busy || isMe}
        title={isMe ? "You can't remove yourself" : 'Remove user'}
        className="p-2 rounded-full text-on-surface-variant hover:bg-error-container/50 hover:text-error transition-colors disabled:opacity-30"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

function CredentialsBanner({ email, password, onDismiss }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard
      ?.writeText(`Email: ${email}\nPassword: ${password}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  }
  return (
    <div className="mb-4 p-4 rounded-xl bg-primary-container/40 border border-primary/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label-md text-on-surface font-semibold">
            Account ready — share these credentials now
          </p>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            The password is shown only once. The user can change it after signing in.
          </p>
          <div className="mt-2 font-mono text-body-sm text-on-surface bg-surface rounded-lg px-3 py-2 border border-outline-variant">
            <div>Email: {email}</div>
            <div>Password: {password}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={copy}
            title="Copy"
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
          </button>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="p-2 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Accounts created without a full name fall back to a name derived from the
// email ("jose@…" → "Jose") instead of an em dash that reads as broken data.
function nameFromEmail(email) {
  const local = email?.split('@')[0];
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Fixed locale — the UI is English, so dates shouldn't follow the browser's.
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
