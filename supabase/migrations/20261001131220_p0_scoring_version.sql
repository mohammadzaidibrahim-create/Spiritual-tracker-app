-- P0 step 3: label daily records with the scoring rules they were saved under.
--
-- Owner decisions P0-05/P0-06 (2026-10-01): a recorded lapse no longer
-- subtracts points, and historical scores stay exactly as stored. Days saved
-- by the updated app carry scoring_version = 2; every existing row keeps NULL,
-- meaning "legacy scoring".
--
-- Additive and nullable: no row is rewritten, no default is set, and clients
-- that do not send the column keep working unchanged. Privileges are not
-- touched; the column is covered by the existing table-level grants.

alter table public.daily_records
  add column scoring_version smallint,
  add constraint daily_records_scoring_version_check
    check (scoring_version is null or scoring_version >= 2);

comment on column public.daily_records.scoring_version is
  'Scoring rules version the score was computed under. NULL = legacy scoring (saved before version 2).';

-- Make the API aware of the new column immediately.
notify pgrst, 'reload schema';
