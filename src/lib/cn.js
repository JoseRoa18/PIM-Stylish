import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The theme's own type scale (index.css `--text-*`). tailwind-merge only knows
// Tailwind's sizes, so it took `text-label-md` for a COLOUR: next to
// `text-on-surface` it kept whichever came last and dropped the other — the
// ScoreCard's tabs lost their size, the avatar its colour. A new `--text-*`
// token goes on this list too.
const TYPE_SCALE = [
  'display-lg', 'display-md', 'display-sm',
  'headline-md', 'headline-sm',
  'title-lg', 'title-md',
  'body-lg', 'body-md', 'body-sm',
  'label-lg', 'label-md', 'label-sm',
  'code-sm',
];

const twMerge = extendTailwindMerge({ extend: { theme: { text: TYPE_SCALE } } });

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
