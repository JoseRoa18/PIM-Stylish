-- EOS ScoreCard rows are grouped by theme (user's layout choice, 2026-11-04).
-- NULL = the theme read from the measurable's name (sectionOf in
-- src/features/scorecard/lib/sections.js); an admin can set another one.
alter table public.scorecard_metrics add column if not exists section text;
