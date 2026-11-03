-- agentloom_watch: what the admin dashboard (watch.py) may read and write in
-- Rakazo's database. Re-applied on every deploy by `watch.py init`, after api
-- has run its migrations, so a migration that rebuilds a table cannot drop
-- these. The role keeps its first name so an existing instance's grants and
-- audit volume carry over.
--
-- Rakazo's own row policies apply to every role through a setting any role
-- can change (app.rls_bypass), so they are not what holds this role. The
-- column grants are: names, counts, timestamps, tokens and spend, never a message,
-- a prompt, an instruction, a session token or an address. The restrictive
-- policy below is what makes its one write a pause and never a start.

alter role agentloom_watch set statement_timeout = '10s';

revoke all on all tables in schema public from agentloom_watch;
grant usage on schema public to agentloom_watch;

grant select (id, "spaceId", "botId", "userId", name, crons, timezone, active,
              "lastRunAt", "nextRunAt", "createdAt") on routines to agentloom_watch;
grant update (active) on routines to agentloom_watch;
grant select (id, "routineId", "userId", status, trigger, "modelProvider", "modelId",
              "createdAt", "startedAt", "completedAt") on runs to agentloom_watch;
grant select (id, name, "userId", "archivedAt", "createdAt") on bots to agentloom_watch;
grant select (id, name, "createdByUserId", "organizationId", "createdAt") on spaces to agentloom_watch;
grant select (id, name, email, "emailVerified", "createdAt") on "user" to agentloom_watch;
grant select ("userId", "createdAt", "updatedAt", "expiresAt") on session to agentloom_watch;
-- Turns and Billing: which call belongs to which turn and account, its tokens and its cost.
grant select (id, "spaceId", "userId", "botId", "runId", "parentRunId", provider, model,
              "inputTokens", "outputTokens", "cacheReadTokens", "totalTokens", "costUsd",
              "costSource", "operationKind", "createdAt")
  on usage_records to agentloom_watch;
grant select (id, name, "createdAt") on organization to agentloom_watch;
grant select ("organizationId", "userId", role) on member to agentloom_watch;
-- Whether a person connected their own key for a provider, so a call on it is theirs to pay.
-- The two columns that say so, never the key.
grant select ("userId", provider) on user_model_credentials to agentloom_watch;

drop policy if exists watch_read on routines;
create policy watch_read on routines for select to agentloom_watch using (true);
drop policy if exists watch_stop on routines;
create policy watch_stop on routines for update to agentloom_watch
  using (active) with check (active = false);
drop policy if exists watch_stop_only on routines;
create policy watch_stop_only on routines as restrictive for update to agentloom_watch
  using (true) with check (active = false);

-- A read policy on every other table it reads, so a table upstream later puts
-- under row security stays readable. A policy on a table without row security
-- does nothing.
do $$
declare t text;
begin
  foreach t in array array['runs', 'bots', 'spaces', 'user', 'session', 'usage_records',
                         'organization', 'member', 'user_model_credentials'] loop
    execute format('drop policy if exists watch_read on %I', t);
    execute format('create policy watch_read on %I for select to agentloom_watch using (true)', t);
  end loop;
end $$;
