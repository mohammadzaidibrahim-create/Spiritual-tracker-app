alter table public.daily_records alter column score type numeric(10,2) using score::numeric(10,2);
alter table public.daily_records alter column max_score type numeric(10,2) using max_score::numeric(10,2);
alter table public.daily_records drop constraint if exists daily_records_score_check;
alter table public.daily_records drop constraint if exists daily_records_max_score_check;
alter table public.daily_records add constraint daily_records_score_check check (score >= 0);
alter table public.daily_records add constraint daily_records_max_score_check check (max_score >= 0);