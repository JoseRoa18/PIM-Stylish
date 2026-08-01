import { useState } from 'react';
import { cn } from '@/lib/cn';

const SIZE_STYLES = {
  sm: 'w-8 h-8 text-body-sm',
  md: 'w-9 h-9 text-body-sm',
  lg: 'w-12 h-12 text-title-lg',
  xl: 'w-20 h-20 text-headline-md',
};

// Two initials from a name ("Jane Doe" → JD), or the first letter of the
// email as a fallback ("pricing@…" → P).
function getInitials(name, email) {
  const trimmed = name?.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  }
  return email?.charAt(0).toUpperCase() ?? '?';
}

/**
 * User avatar — the profile photo when `src` is set, otherwise a
 * brand-colored initials circle. Used wherever a user is shown (topbar,
 * activity log, user management). Decorative by default since it always sits
 * next to the person's name or email; pass aria-* props to override when
 * used standalone.
 */
export default function Avatar({ name, email, src, size = 'md', className, ...rest }) {
  // If the photo 404s (deleted file, offline) fall back to initials; keyed by
  // src so a newly uploaded photo gets a fresh chance.
  const [failedSrc, setFailedSrc] = useState(null);
  const showPhoto = Boolean(src) && src !== failedSrc;

  return (
    <div
      aria-hidden="true"
      className={cn(
        // Container pair instead of solid primary: light = soft rose circle
        // with wine initials (legible at small sizes), dark = muted deep wine
        // instead of the loud salmon. Matches the tinted channel tiles.
        'rounded-full bg-primary-container text-on-primary-container font-semibold flex items-center justify-center flex-shrink-0 select-none overflow-hidden',
        SIZE_STYLES[size] ?? SIZE_STYLES.md,
        className
      )}
      {...rest}
    >
      {showPhoto ? (
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
          className="w-full h-full object-cover"
        />
      ) : (
        getInitials(name, email)
      )}
    </div>
  );
}
