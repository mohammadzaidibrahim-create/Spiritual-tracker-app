revoke all on table public.daily_records from anon;
revoke all on table public.user_preferences from anon;
revoke truncate, references, trigger on table public.daily_records from authenticated;
revoke truncate, references, trigger on table public.user_preferences from authenticated;
grant select, insert, update, delete on table public.daily_records to authenticated;
grant select, insert, update, delete on table public.user_preferences to authenticated;