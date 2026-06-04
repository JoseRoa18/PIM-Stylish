const AVATAR_COLORS = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#F97316', // orange
  '#A855F7', // purple
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EAB308', // amber
  '#EC4899', // pink
];

/**
 * Returns a consistent color based on initials.
 * Same initials always produce the same color across the app.
 */
export function getColorForInitials(initials) {
  if (!initials) return '#94A3B8'; // slate fallback
  const hash = [...initials].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}