// Single source of truth for role metadata, shared by the Users page and the
// add/edit dialogs. Keep in sync with the CHECK constraint in the
// 20260614_user_roles.sql migration and the admin-users Edge Function.

export const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin', description: 'Manages users + full access' },
  { value: 'editor', label: 'Editor', description: 'Edit products, no user management' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only' },
];

export const ROLE_LABELS = Object.fromEntries(
  ROLE_OPTIONS.map((r) => [r.value, r.label]),
);

// Tailwind classes for the role badge (uses design-system tokens).
export const ROLE_BADGE = {
  admin: 'bg-primary-container text-on-primary-container',
  editor: 'bg-secondary-container text-on-secondary-container',
  viewer: 'bg-surface-container-high text-on-surface-variant',
};
