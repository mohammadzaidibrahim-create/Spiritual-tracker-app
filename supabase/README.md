# Supabase migrations

`migrations/` is the reviewed history of the live database schema for project
`ccpaacfzjolyvjnaqtnr`. Each file is named `<version>_<name>.sql`, matching the
live `supabase_migrations.schema_migrations` table.

The first eight files were pulled from the live migration history on
2026-10-01 and verified byte-for-byte (MD5) against it. Before this, the
schema existed only in the live project.

## Rules

- **No secrets.** Migrations are public. Never put keys, passwords, tokens or
  user data in them.
- **Every change goes through a migration file here.** No dashboard-only schema
  or privilege edits.
- **Grants are explicit.** New tables and functions in `public` automatically
  get privileges for `anon` and `authenticated` (Supabase default privileges).
  Every migration that creates an object must revoke what the app does not need.
- **Rehearse, then apply.** Run each migration first inside a transaction that
  is deliberately rolled back, with validation queries for row counts, data
  fingerprints, privileges and RLS. Apply it for real only after the
  rehearsal passes and the owner has approved the plan. Re-run the same
  validation afterwards.
- **Pre-migration export.** Take an export before any migration that alters
  tables holding user data.
