-- agentloom_watch: what agentloom-watch may read and write in Rakazo's
-- database. Re-applied on every deploy by `watch.py init`, after api has run
-- its migrations, so a migration that rebuilds a table cannot drop these.
--
-- Rakazo's own row policies apply to every role through a setting any role
-- can change (app.rls_bypass), so they are not what holds this role. The
-- column grants are, and the restrictive policy below is what makes a write
-- a pause and never a start.

alter role agentloom_watch set statement_timeout = '10s';

revoke all on all tables in schema public from agentloom_watch;
grant usage on schema public to agentloom_watch;

grant select (id, "spaceId", "botId", "userId", name, crons, timezone, active,
              "lastRunAt", "nextRunAt", "createdAt") on routines to agentloom_watch;
grant update (active) on routines to agentloom_watch;
grant select (id, "routineId", status, trigger, "createdAt", "startedAt", "completedAt")
  on runs to agentloom_watch;
grant select (id, name) on bots to agentloom_watch;
grant select (id, name) on spaces to agentloom_watch;
grant select (id, name, email) on "user" to agentloom_watch;

drop policy if exists watch_read on routines;
create policy watch_read on routines for select to agentloom_watch using (true);
drop policy if exists watch_stop on routines;
create policy watch_stop on routines for update to agentloom_watch
  using (active) with check (active = false);
drop policy if exists watch_stop_only on routines;
create policy watch_stop_only on routines as restrictive for update to agentloom_watch
  using (true) with check (active = false);

drop policy if exists watch_read on runs;
create policy watch_read on runs for select to agentloom_watch using (true);
drop policy if exists watch_read on bots;
create policy watch_read on bots for select to agentloom_watch using (true);
