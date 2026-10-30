#!/usr/bin/env python3
"""agentloom-watch: every AgentLoom routine on one page, and a Stop that pauses one.

Sits behind oauth2-proxy (authentik Admins) and believes identity headers only
from it. Its database role reads names, owners, schedules and run states -
never a prompt or a message - and can write one column, routines.active, and
only to false (init.sql). Stopping is all it does: the routine's owner turns it
back on in AgentLoom, because resuming means scheduling, which is the app's.

  watch.py serve   the page, as agentloom_watch
  watch.py init    create or re-grant that role, as the database owner; runs on
                   every deploy, after api has migrated
"""
import html
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg
from psycopg import sql

DB = {"host": "postgres", "dbname": "rakazo", "connect_timeout": 5}
PROXY = os.environ.get("TRUSTED_PROXY", "10.231.70.10")
ORIGIN = os.environ.get("WATCH_ORIGIN", "")
AUDIT = Path("/data/audit.jsonl")
ROUTINE_ID = re.compile(r"^[a-z0-9]{10,40}$")

LIST = """
select r.id, coalesce(u.email, r."userId"), coalesce(s.name, r."spaceId"),
       coalesce(b.name, r."botId"), r.name, r.crons, r.timezone, r.active,
       r."lastRunAt", r."nextRunAt", lr.status, lr."createdAt"
from routines r
left join "user" u on u.id = r."userId"
left join spaces s on s.id = r."spaceId"
left join bots b on b.id = r."botId"
left join lateral (
  select status, "createdAt" from runs
  where "routineId" = r.id order by "createdAt" desc limit 1
) lr on true
order by r.active desc, r."nextRunAt" nulls last, r.name
"""
PAUSE = 'update routines set active = false where id = %s and active returning name'


def init():
    """Owner side: the role, its column grants and its policies. Idempotent."""
    pw = os.environ["WATCH_DB_PASSWORD"]
    with psycopg.connect(**DB, user="rakazo", password=os.environ["POSTGRES_PASSWORD"], autocommit=True) as c:
        if not c.execute("select 1 from pg_roles where rolname = 'agentloom_watch'").fetchone():
            c.execute("create role agentloom_watch login")
        c.execute(sql.SQL("alter role agentloom_watch login nosuperuser nobypassrls nocreatedb "
                          "nocreaterole password {}").format(sql.Literal(pw)))
        c.execute(Path(__file__).with_name("init.sql").read_text())
    print("agentloom_watch: role, grants and policies applied")


def utc(ts):
    return ts.replace(tzinfo=timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if ts else "-"


def audit_tail(n=30):
    try:
        lines = AUDIT.read_text().splitlines()[-n:]
    except FileNotFoundError:
        return []
    return [json.loads(x) for x in reversed(lines)]


CSS = """
:root{--bg:#fafafa;--fg:#1a1a1a;--mute:#6b6b6b;--line:#e3e3e3;--card:#fff;--stop:#b42318;--on:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#171717;--fg:#ececec;--mute:#9a9a9a;--line:#2e2e2e;--card:#1f1f1f;--stop:#f97066;--on:#47cd89}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px}
p.sub{color:var(--mute);margin:0 0 20px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:0}
.on{color:var(--on)}.off{color:var(--mute)}
details{position:relative}summary{cursor:pointer;list-style:none;padding:0 6px;border-radius:4px}
summary::-webkit-details-marker{display:none}
details[open] form{position:absolute;right:0;z-index:2;background:var(--card);border:1px solid var(--line);
  border-radius:8px;padding:10px;width:260px;box-shadow:0 4px 16px rgba(0,0,0,.15)}
input[type=text]{width:100%;box-sizing:border-box;padding:6px;margin:0 0 8px;background:var(--bg);color:var(--fg);
  border:1px solid var(--line);border-radius:4px}
button{padding:6px 10px;border-radius:4px;border:1px solid var(--stop);background:none;color:var(--stop);cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.note{padding:8px 12px;border-radius:6px;background:var(--card);border:1px solid var(--line);margin:0 0 16px}
"""


def page(rows, who, note):
    e = html.escape
    body = []
    for (rid, owner, space, bot, name, crons, tz, active, last, nxt, lstatus, lat) in rows:
        if active:
            act = (f'<form method="post" action="/stop"><input type="hidden" name="id" value="{e(rid)}">'
                   f'<input type="text" name="reason" required maxlength="300" placeholder="Why (recorded)">'
                   f'<button>Stop {e(name)}</button></form>')
        else:
            act = ('<form><button disabled title="Already stopped. Its owner turns it back on in '
                   'AgentLoom.">Stop</button></form>')
        body.append(
            f"<tr><td>{e(name)}</td><td>{e(bot)}</td><td>{e(space)}</td><td>{e(owner)}</td>"
            f"<td>{e(', '.join(crons or []) or '-')} <span class=off>{e(tz)}</span></td>"
            f"<td class={'on' if active else 'off'}>{'running' if active else 'stopped'}</td>"
            f"<td>{utc(nxt) if active else '-'}</td><td>{utc(last)}</td>"
            f"<td>{e(lstatus or '-')} <span class=off>{utc(lat) if lat else ''}</span></td>"
            f"<td><details><summary title=Actions>...</summary>{act}</details></td></tr>")
    if not body:
        body.append('<tr><td colspan=10 class=off>No routines yet.</td></tr>')
    log = "".join(
        f"<tr><td>{e(a['at'])}</td><td>{e(a['by'])}</td><td>{e(a['routine'])}</td>"
        f"<td>{e(a['owner'])}</td><td>{e(a['reason'])}</td></tr>" for a in audit_tail())
    log = log or '<tr><td colspan=5 class=off>Nothing stopped yet.</td></tr>'
    banner = f'<div class=note>{e(note)}</div>' if note else ""
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>AgentLoom Watch</title>
<style>{CSS}</style></head><body><main>
<h1>AgentLoom Watch</h1>
<p class=sub>Every routine, for every person. Stop pauses one before its next run; its owner turns it back on in AgentLoom. Signed in as {e(who)}.</p>
{banner}
<div class=wrap><table><tr><th>Routine</th><th>Bot</th><th>Space</th><th>Owner</th><th>Schedule</th>
<th>State</th><th>Next run</th><th>Last run</th><th>Last run status</th><th>Actions</th></tr>
{''.join(body)}</table></div>
<h2>Stopped from here</h2>
<div class=wrap><table><tr><th>When</th><th>By</th><th>Routine</th><th>Owner</th><th>Why</th></tr>
{log}</table></div></main></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "agentloom-watch"

    def who(self):
        if self.client_address[0] != PROXY:
            return None
        return self.headers.get("X-Forwarded-Email") or self.headers.get("X-Forwarded-User")

    def send(self, code, body, ctype="text/html; charset=utf-8", headers=()):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health" and self.client_address[0] == "127.0.0.1":
            return self.send(200, "ok", "text/plain")
        who = self.who()
        if not who:
            return self.send(403, "forbidden", "text/plain")
        if url.path != "/":
            return self.send(404, "not found", "text/plain")
        note = (parse_qs(url.query).get("note") or [""])[0][:200]
        with psycopg.connect(**DB, user="agentloom_watch", password=os.environ["WATCH_DB_PASSWORD"]) as c:
            rows = c.execute(LIST).fetchall()
        self.send(200, page(rows, who, note))

    def do_POST(self):
        who = self.who()
        if not who:
            return self.send(403, "forbidden", "text/plain")
        if self.path != "/stop":
            return self.send(404, "not found", "text/plain")
        origin = self.headers.get("Origin")
        if not ORIGIN or origin != ORIGIN:
            return self.send(403, "cross-origin request refused", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4096:
            return self.send(413, "too large", "text/plain")
        form = parse_qs(self.rfile.read(n).decode())
        rid = (form.get("id") or [""])[0]
        reason = (form.get("reason") or [""])[0].strip()[:300]
        if not ROUTINE_ID.match(rid) or not reason:
            return self.send(400, "a routine id and a reason are required", "text/plain")
        with psycopg.connect(**DB, user="agentloom_watch", password=os.environ["WATCH_DB_PASSWORD"]) as c:
            hit = c.execute(PAUSE, (rid,)).fetchone()
            owner = c.execute('select coalesce(u.email, r."userId") from routines r left join "user" u '
                              'on u.id = r."userId" where r.id = %s', (rid,)).fetchone()
        if not hit:
            note = "That routine was already stopped."
        else:
            entry = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), "by": who,
                     "routine": hit[0], "routine_id": rid, "owner": owner[0] if owner else "-",
                     "reason": reason}
            with AUDIT.open("a") as f:
                f.write(json.dumps(entry) + "\n")
            print(f"stopped {rid} ({hit[0]}) by {who}: {reason}", flush=True)
            note = f"Stopped {hit[0]}. Its next run will not happen."
        self.send(303, "", headers=[("Location", "/?note=" + note.replace(" ", "+"))])

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if sys.argv[1:] == ["init"]:
        init()
    else:
        ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
