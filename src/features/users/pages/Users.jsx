import { useState } from 'react';
import {
  Users as UsersIcon,
  UserPlus,
  Loader2,
  KeyRound,
  Trash2,
  AlertCircle,
  Check,
  X,
  Pencil,
} from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { Copy as CopyGlyph, Check as CheckGlyph } from 'lucide';
import { useAuth } from '@/features/auth/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmProvider';
import Avatar from '@/components/ui/Avatar';
import { nameFromEmail } from '@/lib/format';
import { useUsers } from '../hooks/useUsers';
import { updateUserRole, updateUserName, resetUserPassword, deleteUser } from '../api/users';
import { generatePassword } from '../password';
import { ROLE_OPTIONS, ROLE_BADGE, ROLE_LABELS } from '../roles';
import AddUserDialog from '../components/AddUserDialog';

export default function Users() {
  const { user: me, refreshProfile } = useAuth();
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

  // Returns true when the rename went through, so the row can leave edit mode
  // only on success and keep the typed value on failure.
  async function handleRename(u, fullName) {
    if (fullName === (u.full_name ?? '')) return true;
    setActionError(null);
    setBusyId(u.id);
    try {
      await updateUserName(u.id, fullName);
      await reload();
      // Renaming yourself must also update the topbar, which reads the profile
      // from the auth context rather than this list.
      if (u.id === me?.id) await refreshProfile();
      return true;
    } catch (err) {
      setActionError(err.message);
      return false;
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
                    <UserIdentity user={u} isMe={isMe} busy={busy} onRename={handleRename} />
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
                      Last active: {formatDate(u.last_active_at ?? u.last_sign_in_at)}
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
                  <th className="px-5 py-3 font-medium">Last active</th>
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
                        <UserIdentity user={u} isMe={isMe} busy={busy} onRename={handleRename} />
                      </td>
                      <td className="px-5 py-3">
                        <RoleControl user={u} isMe={isMe} busy={busy} onChange={handleRoleChange} />
                      </td>
                      <td
                        className="px-5 py-3 text-body-sm text-on-surface-variant"
                        title={`Last password sign-in: ${formatDate(u.last_sign_in_at)}`}
                      >
                        {formatDate(u.last_active_at ?? u.last_sign_in_at)}
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

/**
 * Avatar + name + email for one row. The name is editable in place: accounts
 * are often created without one, and it's what the rest of the app shows
 * instead of the email address.
 */
function UserIdentity({ user, isMe, busy, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  function startEditing() {
    setValue(user.full_name ?? '');
    setEditing(true);
  }

  async function submit(e) {
    e.preventDefault();
    const ok = await onRename(user, value.trim());
    // On failure the row stays open with what they typed; the error shows in
    // the page-level banner.
    if (ok) setEditing(false);
  }

  return (
    <div className="flex items-center gap-3">
      <Avatar name={user.full_name} email={user.email} src={user.avatar_url} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={submit} className="flex items-center gap-1">
            <input
              autoFocus
              value={value}
              maxLength={80}
              placeholder={nameFromEmail(user.email)}
              aria-label={`Full name for ${user.email}`}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
              }}
              className="min-w-0 flex-1 px-2 py-1 rounded-lg border border-outline-variant bg-surface text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            <button
              type="submit"
              disabled={busy}
              title="Save name"
              className="p-1.5 rounded-full text-primary hover:bg-primary-container/50 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              title="Cancel"
              className="p-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-low transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-1 min-w-0">
            {/* A name derived from the email is muted, so it's obvious at a
                glance who still hasn't got a real one on file. */}
            <span
              className={`text-body-md truncate ${
                user.full_name ? 'text-on-surface' : 'text-on-surface-variant'
              }`}
            >
              {user.full_name || nameFromEmail(user.email) || '—'}
            </span>
            {isMe && (
              <span className="text-label-sm text-on-surface-variant flex-shrink-0">(you)</span>
            )}
            <button
              type="button"
              onClick={startEditing}
              title="Edit name"
              aria-label={`Edit name for ${user.email}`}
              className="p-1 rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors flex-shrink-0"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="text-body-sm text-on-surface-variant truncate">{user.email}</div>
      </div>
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
            <MorphIcon icon={copied ? CheckGlyph : CopyGlyph} size={16} reducedMotion="user" className={copied ? 'text-primary' : ''} />
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

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Fixed locale — the UI is English, so dates shouldn't follow the browser's.
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
