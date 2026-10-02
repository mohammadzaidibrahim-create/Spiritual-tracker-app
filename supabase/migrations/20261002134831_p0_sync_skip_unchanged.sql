-- P0 Step 6.1a — server-side no-op protection for identical updates.
--
-- If an UPDATE (including the UPDATE half of an upsert) would leave every column
-- except updated_at exactly as stored, the row update is skipped: the existing
-- row, including updated_at, stays untouched. Any genuine change proceeds
-- exactly as before.
--
-- Strictly a no-op guard. It never changes score, max_score, scoring_version,
-- saved_at, record_date or any other value; never merges, resolves or
-- normalises anything; and bypasses nothing — RLS policies, constraints and the
-- existing updated_at triggers apply exactly as before. SECURITY INVOKER.
create or replace function private.skip_unchanged_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;  -- identical: skip this row's update; the stored row is left as is
  end if;
  return new;     -- NEW unmodified: the update proceeds exactly as before
end;
$$;

revoke all on function private.skip_unchanged_update() from public, anon, authenticated, service_role;

-- BEFORE triggers fire in name order: "0_" sorts before "set_updated_at", so an
-- identical update is skipped before updated_at would be touched.
create trigger daily_records_0_skip_unchanged
  before update on public.daily_records
  for each row execute function private.skip_unchanged_update();

create trigger preferences_0_skip_unchanged
  before update on public.user_preferences
  for each row execute function private.skip_unchanged_update();
