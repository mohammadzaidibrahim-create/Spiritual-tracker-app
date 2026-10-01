-- P0 step 2: lock the recovery/accountability surface until the P1 rebuild.
--
-- Owner decision P0-12 (2026-10-01): lock the existing recovery and
-- accountability tables completely; do not patch the current authorization
-- model. All five tables hold 0 rows and the app does not use them.
--
-- Privileges only, plus dropping one unused function. Reads and writes no
-- rows. RLS and the existing policies stay in place; with no privileges they
-- are unreachable. P1 replaces all of it. profiles, daily_records and
-- user_preferences are deliberately not touched here.

-- Recovery/accountability tables: API roles lose every privilege.
revoke all on table
  public.recovery_profiles,
  public.recovery_events,
  public.accountability_relationships,
  public.accountability_permissions,
  public.mentor_notes
  from anon, authenticated;

-- Accountability functions: API roles may not execute them.
revoke all on function public.create_accountability_relationship(uuid, public.accountability_role) from public, anon, authenticated;
revoke all on function public.respond_to_accountability_relationship(uuid, boolean) from public, anon, authenticated;
revoke all on function public.revoke_accountability_relationship(uuid) from public, anon, authenticated;
revoke all on function public.is_active_accountability_relationship(uuid, uuid, public.accountability_role) from public, anon, authenticated;
revoke all on function private.can_access_user_data(uuid, text) from public, anon, authenticated;
revoke all on schema private from anon, authenticated;

-- Legacy duplicate of private.can_access_user_data. Nothing depends on it
-- (pg_depend) and only postgres/service_role could execute it.
drop function public.can_access_user_data(uuid, text);
