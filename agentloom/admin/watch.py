#!/usr/bin/env python3
"""AgentLoom admin: who uses this instance, what it costs, and every routine.

Served at <origin>/admin behind oauth2-proxy (authentik Admins only) and
believes identity headers only from it. Its database role reads names, counts,
timestamps and spend - never a message, a prompt, a session token or an
address - and can write one column, routines.active, and only to false
(init.sql). Stopping a routine is the only thing it does; its owner turns it
back on in AgentLoom, because resuming means scheduling, which is the app's.

  watch.py serve   the dashboard, as agentloom_watch
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
from urllib.parse import parse_qs, quote_plus, urlparse

import psycopg
from psycopg import sql

DB = {"host": "postgres", "dbname": "rakazo", "connect_timeout": 5}
PROXY = os.environ.get("TRUSTED_PROXY", "10.231.70.10")
ORIGIN = os.environ.get("WATCH_ORIGIN", "")
INSTANCE = os.environ.get("WATCH_INSTANCE", "AgentLoom")
AUDIT = Path("/data/audit.jsonl")
ROUTINE_ID = re.compile(r"^[a-z0-9]{10,40}$")
BASE = "/admin"

# Prisma writes timestamp(3) without a zone, in UTC.
NOW = "(now() at time zone 'utc')"
MONTH = f"date_trunc('month', {NOW})"

OVERVIEW = f"""
select
  (select count(*) from "user"),
  (select count(*) from "user" where "createdAt" > {NOW} - interval '7 days'),
  (select count(*) from "user" where "createdAt" > {NOW} - interval '30 days'),
  (select count(distinct "userId") from session where "updatedAt" > {NOW} - interval '1 day'),
  (select count(distinct "userId") from session where "updatedAt" > {NOW} - interval '7 days'),
  (select count(*) from bots where "archivedAt" is null),
  (select count(*) from routines where active),
  (select count(*) from runs where "createdAt" > {NOW} - interval '1 day'),
  (select count(*) from runs where "createdAt" > {NOW} - interval '1 day' and status = 'failed'),
  (select coalesce(sum("costUsd"), 0) from usage_records where "createdAt" >= {MONTH}),
  (select count(distinct "userId") from usage_records where "createdAt" >= {MONTH})
"""
SIGNUPS = f"""
select d::date, count(u.id)
from generate_series({NOW}::date - 29, {NOW}::date, interval '1 day') d
left join "user" u on u."createdAt"::date = d::date
group by d order by d
"""
SPEND_DAYS = f"""
select d::date, coalesce(sum(r."costUsd"), 0)
from generate_series({NOW}::date - 29, {NOW}::date, interval '1 day') d
left join usage_records r on r."createdAt"::date = d::date
group by d order by d
"""
USERS = f"""
select u.email, u.name, u."emailVerified", u."createdAt",
  (select max("updatedAt") from session s where s."userId" = u.id),
  (select count(*) from bots b where b."userId" = u.id and b."archivedAt" is null),
  (select count(*) from routines r where r."userId" = u.id and r.active),
  (select count(*) from runs x where x."userId" = u.id and x."createdAt" > {NOW} - interval '30 days'),
  (select coalesce(sum("costUsd"), 0) from usage_records ur
     where ur."userId" = u.id and ur."createdAt" >= {MONTH}),
  (select coalesce(sum("totalTokens"), 0) from usage_records ur
     where ur."userId" = u.id and ur."createdAt" >= {MONTH})
from "user" u
order by 5 desc nulls last, u."createdAt" desc
limit 1000
"""
SPEND_MODELS = f"""
select provider, model, count(*), coalesce(sum("totalTokens"), 0), coalesce(sum("costUsd"), 0),
       count(distinct "userId")
from usage_records where "createdAt" >= {MONTH}
group by provider, model order by 5 desc, 3 desc
"""
SPEND_USERS = f"""
select coalesce(u.email, r."userId"), count(*), coalesce(sum(r."totalTokens"), 0),
       coalesce(sum(r."costUsd"), 0)
from usage_records r left join "user" u on u.id = r."userId"
where r."createdAt" >= {MONTH}
group by 1 order by 4 desc limit 50
"""
ROUTINES = """
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

# A call is ours to pay when it cost something and its person connected no key of their own
# for that provider: the run fell back to the instance's key. An estimate until the app's
# own credit ledger (model_credit_entries) is switched on, which records exactly that.
OURS = ('r."costUsd" > 0 and not exists (select 1 from user_model_credentials k '
        'where k."userId" = r."userId" and k.provider = r.provider)')
# One turn is one top-level run: its sub-runs fold into it, a call with no run stands alone.
TURN = 'coalesce(r."parentRunId", r."runId", \'call:\' || r.id)'
TURNS = f"""
with t as (
  select {TURN} turn, min(r."createdAt") at, r."userId", r."spaceId", max(r."botId") bot,
         string_agg(distinct r.model, ', ') models, count(*) calls,
         sum(coalesce(r."inputTokens", 0)) inp, sum(coalesce(r."cacheReadTokens", 0)) cached,
         sum(coalesce(r."outputTokens", 0)) outp, sum(coalesce(r."costUsd", 0)) cost,
         sum(case when {OURS} then r."costUsd" else 0 end) ours,
         bool_or(r."costUsd" is null) unpriced
  from usage_records r where r."createdAt" > {NOW} - interval '30 days'
  group by 1, r."userId", r."spaceId"
)
select t.at, coalesce(u.email, t."userId"), coalesce(o.name, '-'), coalesce(b.name, t.bot, '-'),
       x.trigger, x.status, t.models, t.calls, t.inp, t.cached, t.outp, t.cost, t.ours, t.unpriced
from t
left join "user" u on u.id = t."userId"
left join spaces s on s.id = t."spaceId"
left join organization o on o.id = s."organizationId"
left join bots b on b.id = t.bot
left join runs x on x.id = t.turn
order by t.at desc limit 300
"""
ACCOUNTS = f"""
select o.id, o.name,
  (select min(u.email) from member m join "user" u on u.id = m."userId"
     where m."organizationId" = o.id and m.role like '%owner%'),
  (select count(*) from member m where m."organizationId" = o.id),
  count(distinct {TURN}) filter (where r.id is not null),
  coalesce(sum(r."costUsd"), 0),
  coalesce(sum(case when {OURS} then r."costUsd" end), 0),
  count(r.id) filter (where r."costUsd" = 0)
from organization o
left join spaces s on s."organizationId" = o.id
left join usage_records r on r."spaceId" = s.id and r."createdAt" >= {MONTH}
group by o.id, o.name
order by 7 desc, 6 desc, o.name
"""
PLANS = json.loads(Path(__file__).with_name("plans.json").read_text())
DEFAULT_PLAN = os.environ.get("WATCH_DEFAULT_PLAN", "starter")


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


def db():
    return psycopg.connect(**DB, user="agentloom_watch", password=os.environ["WATCH_DB_PASSWORD"])


e = html.escape


def utc(ts):
    return ts.replace(tzinfo=timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else "-"


def ago(ts):
    if not ts:
        return "never"
    s = (datetime.now(timezone.utc) - ts.replace(tzinfo=timezone.utc)).total_seconds()
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= n:
            return f"{int(s // n)}{unit} ago"
    return "just now"


def usd(x):
    x = float(x or 0)
    return f"${x:,.2f}" if x >= 0.01 or x == 0 else f"${x:.4f}"


def num(x):
    return f"{int(x or 0):,}"


def audit_tail(n=30):
    try:
        lines = AUDIT.read_text().splitlines()[-n:]
    except FileNotFoundError:
        return []
    return [json.loads(x) for x in reversed(lines)]


def table(head, rows, empty):
    th = "".join(f"<th{' class=n' if h.startswith('#') else ''}>{e(h.lstrip('#'))}</th>" for h in head)
    body = "".join(rows) or f'<tr><td colspan={len(head)} class=off>{e(empty)}</td></tr>'
    return f"<div class=wrap><table><tr>{th}</tr>{body}</table></div>"


def bars(points, fmt):
    """30 daily values as a bar strip; the tallest bar is the label's scale."""
    top = max((float(v) for _, v in points), default=0) or 1
    cols = "".join(
        f'<div class=bar title="{d:%b %d}: {e(fmt(v))}"><i style="height:{max(2, 100 * float(v) / top):.0f}%"></i></div>'
        for d, v in points)
    first, last = (points[0][0], points[-1][0]) if points else (None, None)
    span = f"{first:%b %d} - {last:%b %d}" if first else ""
    return (f'<div class=chart><div class=bars>{cols}</div>'
            f'<div class=axis><span>{span}</span><span>peak {e(fmt(top))}</span></div></div>')


CSS = """
:root{--bg:#fafafa;--fg:#1a1a1a;--mute:#6b6b6b;--line:#e3e3e3;--card:#fff;--stop:#b42318;--on:#067647;--acc:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#171717;--fg:#ececec;--mute:#9a9a9a;--line:#2e2e2e;--card:#1f1f1f;--stop:#f97066;--on:#47cd89;--acc:#91a7ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{border-bottom:1px solid var(--line);background:var(--card)}
header .in{max-width:1200px;margin:0 auto;padding:12px 16px;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
header b{font-size:15px}header nav{display:flex;gap:4px}
header nav a{color:var(--mute);text-decoration:none;padding:6px 10px;border-radius:6px}
header nav a.cur{color:var(--fg);background:var(--bg)}
header .who{margin-left:auto;color:var(--mute);font-size:12px}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px}
p.sub{color:var(--mute);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.tile .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.tile .k{color:var(--mute);font-size:12px}
.tile .s{color:var(--mute);font-size:12px;margin-top:2px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px}
.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.bars{display:flex;align-items:flex-end;gap:3px;height:120px}
.bar{flex:1;height:100%;display:flex;align-items:flex-end}.bar i{display:block;width:100%;background:var(--acc);border-radius:2px 2px 0 0}
.axis{display:flex;justify-content:space-between;color:var(--mute);font-size:12px;margin-top:6px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:12px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.on{color:var(--on)}.off{color:var(--mute)}.bad{color:var(--stop)}
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

# Turns and Billing ride on /spend?v= so the proxies' /admin path rules need no new entry.
TABS = (("", "Overview"), ("/users", "Users"), ("/spend", "Spend"), ("/spend?v=turns", "Turns"),
        ("/spend?v=billing", "Billing"), ("/routines", "Routines"))


def shell(cur, who, title, sub, content, note=""):
    nav = "".join(f'<a href="{BASE}{p}"{" class=cur" if p == cur else ""}>{e(n)}</a>' for p, n in TABS)
    banner = f'<div class=note>{e(note)}</div>' if note else ""
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>
<title>{e(title)} - {e(INSTANCE)} admin</title><style>{CSS}</style></head><body>
<header><div class=in><b>{e(INSTANCE)} admin</b><nav>{nav}</nav>
<span class=who>{e(who)} · <a class=off href="{BASE}/oauth2/sign_out">sign out</a></span></div></header>
<main><h1>{e(title)}</h1><p class=sub>{e(sub)}</p>{banner}{content}</main></body></html>"""


def tile(k, v, s=""):
    return f'<div class=tile><div class=k>{e(k)}</div><div class=v>{e(v)}</div><div class=s>{e(s)}</div></div>'


def overview(c, who):
    (users, new7, new30, act1, act7, bots, routines, runs1, fail1, spend, payers) = c.execute(OVERVIEW).fetchone()
    tiles = "".join([
        tile("Users", num(users), f"+{num(new7)} this week · +{num(new30)} in 30 days"),
        tile("Active today", num(act1), f"{num(act7)} this week"),
        tile("Bots", num(bots), "not archived"),
        tile("Routines running", num(routines)),
        tile("Runs, last 24h", num(runs1), f"{num(fail1)} failed" if fail1 else "none failed"),
        tile("Spend this month", usd(spend), f"across {num(payers)} users"),
        tile("Per user with usage", usd(float(spend) / payers if payers else 0), "this month"),
    ])
    charts = (f'<div class=grid2><div><h2>Sign-ups, last 30 days</h2>{bars(c.execute(SIGNUPS).fetchall(), num)}</div>'
              f'<div><h2>Spend per day, last 30 days</h2>{bars(c.execute(SPEND_DAYS).fetchall(), usd)}</div></div>')
    return shell("", who, "Overview", "This instance at a glance. Times are UTC.", f"<div class=tiles>{tiles}</div>{charts}")


def users(c, who):
    rows = []
    for (email, name, verified, created, seen, bots, routines, runs, spend, tokens) in c.execute(USERS).fetchall():
        rows.append(
            f"<tr><td>{e(email)}{'' if verified else ' <span class=off title=Unverified>·</span>'}</td>"
            f"<td>{e(name)}</td><td>{utc(created)}</td><td title='{utc(seen)}'>{ago(seen)}</td>"
            f"<td class=n>{num(bots)}</td><td class=n>{num(routines)}</td><td class=n>{num(runs)}</td>"
            f"<td class=n>{num(tokens)}</td><td class=n>{usd(spend)}</td></tr>")
    t = table(["Email", "Name", "Signed up", "Last seen", "#Bots", "#Routines", "#Runs 30d",
               "#Tokens this month", "#Spend this month"], rows, "No users yet.")
    return shell("/users", who, "Users", f"{len(rows)} accounts, most recently seen first. "
                 "Counts only: no chat, file or memory is readable from here.", t)


def spend(c, who):
    m = [f"<tr><td>{e(p)}</td><td>{e(mod)}</td><td class=n>{num(n)}</td><td class=n>{num(t)}</td>"
         f"<td class=n>{usd(cost)}</td><td class=n>{num(u)}</td></tr>"
         for (p, mod, n, t, cost, u) in c.execute(SPEND_MODELS).fetchall()]
    u = [f"<tr><td>{e(email)}</td><td class=n>{num(n)}</td><td class=n>{num(t)}</td><td class=n>{usd(cost)}</td></tr>"
         for (email, n, t, cost) in c.execute(SPEND_USERS).fetchall()]
    content = (f"{bars(c.execute(SPEND_DAYS).fetchall(), usd)}"
               f"<h2>By model, this month</h2>"
               f"{table(['Provider', 'Model', '#Calls', '#Tokens', '#Cost', '#Users'], m, 'Nothing spent this month.')}"
               f"<h2>Top 50 users, this month</h2>"
               f"{table(['User', '#Calls', '#Tokens', '#Cost'], u, 'Nothing spent this month.')}")
    return shell("/spend", who, "Spend", "What the models cost, from AgentLoom's own usage records. "
                 "A local model records its calls and tokens at no cost.", content)


def turns(c, who):
    rows = []
    for (at, user, account, bot, trigger, status, models, calls, inp, cached, outp, cost, ours,
         unpriced) in c.execute(TURNS).fetchall():
        payer = "ours" if ours else "theirs" if cost else "unpriced" if unpriced else "free"
        flag = ' <span class=bad title="A call has no price yet">?</span>' if unpriced else ""
        rows.append(
            f"<tr><td>{utc(at)}</td><td>{e(user)}</td><td>{e(account)}</td><td>{e(bot)}</td>"
            f"<td>{e(trigger or '-')}</td><td class={'bad' if status == 'failed' else ''}>{e(status or '-')}</td>"
            f"<td>{e(models)}</td><td class=n>{num(calls)}</td><td class=n>{num(inp)}</td>"
            f"<td class=n>{num(cached)}</td><td class=n>{num(outp)}</td>"
            f"<td class=n>{usd(cost)}{flag}</td>"
            f"<td class={'on' if payer == 'ours' else 'off'}>{payer}</td></tr>")
    t = table(["When", "Person", "Account", "Bot", "Started by", "Status", "Models", "#Calls",
               "#Input", "#Cached", "#Output", "#Cost", "Paid by"], rows, "No turns in 30 days.")
    return shell("/spend?v=turns", who, "Turns", "One row per agent turn in the last 30 days, newest "
                 "first, up to 300. A turn is one run with its sub-runs; Input is uncached tokens. "
                 "Paid by: ours = the instance's key, theirs = a key the person connected, "
                 "free = a local model. ? = a call whose price is not known yet.", t)


def card_fee(x):
    f = PLANS["fees"]
    return x * f["card_pct"] + f["card_fixed"] if x > 0 else 0.0


def billing(c, who):
    markup, fee = PLANS["markup"], PLANS["fees"]["openrouter"]
    rows, tot = [], {"rev": 0.0, "cost": 0.0, "margin": 0.0, "over": 0}
    for (_, name, owner, members, nturns, cost, ours, free) in c.execute(ACCOUNTS).fetchall():
        key = PLANS["accounts"].get(owner or "", DEFAULT_PLAN)
        plan = PLANS["plans"][key]
        charged = float(ours) * markup
        included = plan["credits"]
        over = max(0.0, charged - included) if included is not None else 0.0
        left = max(0.0, included - charged) if included is not None else None
        revenue = plan["price"] + over
        ai = float(ours) * (1 + fee)
        margin = revenue - ai - card_fee(revenue)
        cap = plan["users"]
        tot["rev"] += revenue
        tot["cost"] += ai
        tot["margin"] += margin
        tot["over"] += over > 0
        used = f"{100 * charged / included:.0f}%" if included else "-"
        rows.append(
            f"<tr><td>{e(name)}</td><td>{e(owner or '-')}</td><td>{e(plan['name'])}</td>"
            f"<td class='n{' bad' if cap and members > cap else ''}'>{num(members)}{f' / {cap}' if cap else ''}</td>"
            f"<td class=n>{num(nturns)}</td><td class=n>{num(free)}</td><td class=n>{usd(cost)}</td>"
            f"<td class=n>{usd(ours)}</td><td class=n>{used}</td>"
            f"<td class=n>{usd(left) if left is not None else '-'}</td>"
            f"<td class='n{' bad' if over else ''}'>{usd(over)}</td><td class=n>{usd(revenue)}</td>"
            f"<td class='n{' bad' if margin < 0 else ''}'>{usd(margin)}</td></tr>")
    tiles = "".join([
        tile("Would bill this month", usd(tot["rev"]), "plans plus overage"),
        tile("Our AI cost", usd(tot["cost"]), f"model cost + {fee:.1%} OpenRouter fee"),
        tile("Margin", usd(tot["margin"]), "after AI and card fees; hosting not counted"),
        tile("Over allowance", num(tot["over"]), "accounts"),
        tile("Credits charged at", f"{markup:g}x", "model cost, plans.json"),
    ])
    t = table(["Account", "Owner", "Plan", "#People", "#Turns", "#Free calls", "#All cost",
               "#Ours", "#Credits used", "#Credits left", "#Overage", "#Would bill", "#Margin"],
              rows, "No accounts yet.")
    return shell("/spend?v=billing", who, "Billing", "This month, per account, against the plan it "
                 f"would be on. Tracking only: nothing is charged. An account with no entry in "
                 f"plans.json is on {PLANS['plans'][DEFAULT_PLAN]['name']}. Ours is the estimate "
                 "described on Turns.", f"<div class=tiles>{tiles}</div><h2>Accounts</h2>{t}")


def routines(c, who, note):
    body = []
    for (rid, owner, space, bot, name, crons, tz, active, last, nxt, lstatus, lat) in c.execute(ROUTINES).fetchall():
        if active:
            act = (f'<form method="post" action="{BASE}/stop"><input type="hidden" name="id" value="{e(rid)}">'
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
            f"<td class={'bad' if lstatus == 'failed' else ''}>{e(lstatus or '-')} "
            f"<span class=off>{utc(lat) if lat else ''}</span></td>"
            f"<td><details><summary title=Actions>...</summary>{act}</details></td></tr>")
    log = [f"<tr><td>{e(a['at'])}</td><td>{e(a['by'])}</td><td>{e(a['routine'])}</td>"
           f"<td>{e(a['owner'])}</td><td>{e(a['reason'])}</td></tr>" for a in audit_tail()]
    content = (table(["Routine", "Bot", "Space", "Owner", "Schedule", "State", "Next run", "Last run",
                      "Last run status", "Actions"], body, "No routines yet.")
               + "<h2>Stopped from here</h2>"
               + table(["When", "By", "Routine", "Owner", "Why"], log, "Nothing stopped yet."))
    return shell("/routines", who, "Routines", "Every routine, for every person. Stop pauses one before "
                 "its next run; its owner turns it back on in AgentLoom.", content, note)


PAGES = {"": overview, "/": overview, "/users": users, "/spend": spend}
VIEWS = {"turns": turns, "billing": billing}


class Handler(BaseHTTPRequestHandler):
    server_version = "agentloom-admin"

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
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
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
        if url.path in ("/", ""):
            return self.send(302, "", headers=[("Location", BASE)])
        if not url.path.startswith(BASE):
            return self.send(404, "not found", "text/plain")
        sub = url.path[len(BASE):]
        with db() as c:
            if sub == "/routines":
                note = (parse_qs(url.query).get("note") or [""])[0][:200]
                return self.send(200, routines(c, who, note))
            view = (parse_qs(url.query).get("v") or [""])[0]
            if sub == "/spend" and view in VIEWS:
                return self.send(200, VIEWS[view](c, who))
            if sub in PAGES:
                return self.send(200, PAGES[sub](c, who))
        self.send(404, "not found", "text/plain")

    def do_POST(self):
        who = self.who()
        if not who:
            return self.send(403, "forbidden", "text/plain")
        if self.path != BASE + "/stop":
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
        with db() as c:
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
        self.send(303, "", headers=[("Location", f"{BASE}/routines?note={quote_plus(note)}")])

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if sys.argv[1:] == ["init"]:
        init()
    else:
        ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
