#!/usr/bin/env python3
"""Each AgentLoom instance's compose from this repository's own infra/compose/docker-compose.images.yml.

One branch, one image, two instances that differ only in what they decide:

  app   agentloom/compose.yaml       app.agentloom.com on DMZ, for customers: email and
                                     password with open sign-up, computers behind Rakazo's
                                     egress lock, cloudflared the only way in.
  corp  agentloom/corp/compose.yaml  agentloom.corp.darkcompute.io on CORP, for us: authentik
                                     sign-in only, corp-caddy proxies the host's :80, and
                                     agentloom-watch (corp/watch) beside it.

The image is built by a local runner on each plane (agentloom/runner) from the same
commit and pushed to the registry on that instance's host; neither host builds.

    python3 agentloom/gen-compose.py <upstream-tag>

Run it after every merge from upstream, and commit what it writes.
"""
import json, re, sys
from pathlib import Path
from urllib.parse import urlsplit
import yaml

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "infra" / "compose" / "docker-compose.images.yml"
tag = sys.argv[1]
# Built by the plane's local runner (agentloom/runner/build.sh) and pushed to the
# registry on the instance's own host; the app host never builds.
IMAGE = "127.0.0.1:5000/agentloom-app:agentloom"
UPSTREAM_APP = "ghcr.io/elie222/rakazo/app"
# What both instances decide. Everything else takes upstream's own default.
COMMON = {
    "RAKAZO_IMAGE": UPSTREAM_APP,
    "RAKAZO_IMAGE_TAG": tag,
    "RAKAZO_COMPUTER_IMAGE_TAG": tag,
    "SIGNUPS_ENABLED": "true",
    "SANDBOX_PROVIDER": "docker",
    # Auto Review on for everyone who has not chosen: the deployment's model judges a
    # fetch to a new site instead of stopping to ask, which a sub-agent cannot do.
    # Umami: the tag agentloom/Dockerfile adds loads from and posts to this origin,
    # and the app's CSP allows nothing outside 'self' unless named here.
    # Both instances: the image is one, and its data-domains counts app.agentloom.com only.
    "RAKAZO_CSP_SCRIPT_SRC": "https://a.darkcompute.io",
    "RAKAZO_CSP_CONNECT_SRC": "https://a.darkcompute.io",
}
# What only customers' instance decides.
APP = {
    # Customers are never in our IdP: email and password, open sign-up.
    "AUTH_PASSWORD_ENABLED": "true",
    "AUTH_BREACHED_PASSWORD_CHECK_ENABLED": "true",
    # A bot's computer is a container on this host, which is a VM (an escape stays in
    # it), and restricted egress gives computers the public internet and nothing
    # private: run infra/compose/restrict-computer-egress.sh on the host once.
    "SANDBOX_COMPUTER_EGRESS": "restricted",
    # The host resolves through a private DMZ resolver, which the lock blocks.
    "SANDBOX_COMPUTER_DNS": "1.1.1.1,9.9.9.9",
}
# What only our own instance decides.
CORP = {
    # authentik is the whole gate: no password sign-in, and an account opens for anyone
    # authentik sends back. The slug stays rakazo: an account is keyed by
    # hash(issuer, sub), so a new issuer orphans every existing account.
    "AUTH_PASSWORD_ENABLED": "false",
    "OIDC_ISSUER": "https://auth.darkcompute.io/application/o/darkcompute-rakazo/",
    "OIDC_NAME": "authentik",
    "OIDC_ALLOW_SIGNUP_BYPASS": "true",
    # corp-caddy
    "TRUSTED_PROXIES": "local-networks,10.56.30.243",
}
# Values the deployer holds. Named here, never written; a name an instance's deployer
# does not hold is empty there.
SECRET = {"POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY",
          "SCREEN_PROXY_SECRET", "SANDBOX_SUPERVISOR_TOKEN",
          "EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM",
          # The deployment-wide model: a run with no key of its own uses this one.
          "OPENROUTER_API_KEY",
          # Connect apps: Composio holds each member's app logins (Gmail, Slack, ...).
          "COMPOSIO_API_KEY"}
# corp's only: the darkcompute agents hub, every internal app's tools as one MCP server
# (apps/agents in darkcompute), reached over CORP and published by corp-caddy.
CORP_PRIVATE_MCP_ORIGINS = ["https://agents.corp.darkcompute.io"]
# corp's only: the authentik client, and agentloom-watch's.
CORP_SECRET = {"OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "WATCH_DB_PASSWORD", "WATCH_OIDC_CLIENT_ID",
               "WATCH_OIDC_CLIENT_SECRET", "WATCH_COOKIE_SECRET",
               # the registry's authentik client (agentloom-mcp): a person's token for each app
               "AGENTLOOM_MCP_CLIENT_ID", "AGENTLOOM_MCP_CLIENT_SECRET"}
REGISTRY_KEYS = {"id", "name", "description", "endpoint", "open", "icon", "askWrites"}


def registry(path: Path) -> dict:
    """The instance's one-click apps (packages/core agentloom-registry.ts): a title, where
    "Request a connector" posts (a capture API; its token is AGENTLOOM_CONNECTOR_REQUEST_TOKEN),
    and the apps. Closed key sets, https only,
    ids unique: a bad file stops the generator rather than shipping half a list."""
    doc = (yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else None) or {}
    extra = set(doc) - {"title", "request_url", "apps"}
    if extra:
        raise SystemExit(f"{path}: unknown keys {sorted(extra)}")
    if "request_url" in doc and not str(doc["request_url"]).startswith("https://"):
        raise SystemExit(f"{path}: request_url must be https")
    entries = doc.get("apps") or []
    seen = set()
    for e in entries:
        extra = set(e) - REGISTRY_KEYS
        if extra:
            raise SystemExit(f"{path}: {e.get('id')}: unknown keys {sorted(extra)}")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", str(e.get("id", ""))) or e["id"] in seen:
            raise SystemExit(f"{path}: bad or repeated id {e.get('id')!r}")
        seen.add(e["id"])
        if "endpoint" not in e:
            raise SystemExit(f"{path}: {e['id']}: endpoint is required")
        for k in ("endpoint", "open", "icon"):
            if k in e and not str(e[k]).startswith("https://"):
                raise SystemExit(f"{path}: {e['id']}: {k} must be https")
    return {"title": doc.get("title") or "Apps", "requestUrl": doc.get("request_url"), "apps": entries}
REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])((?:[^{}]|\{[^{}]*\})*))?\}")


def build(host: str, sets: dict, dst: Path, header: str, corp: bool) -> None:
    origin = f"https://{host}"
    SET = {**COMMON, **sets, "BETTER_AUTH_URL": origin, "WEB_ORIGIN": origin, "API_URL": origin,
           "RAKAZO_HOST": host}
    secret = SECRET | (CORP_SECRET if corp else set())

    def sub(s: str) -> str:
        def one(m):
            name, op, arg = m.group(1), m.group(2), m.group(3) or ""
            if name in secret:
                return "${%s}" % name
            if name in SET:
                return SET[name]
            if op == "-":
                return sub(arg)
            raise SystemExit(f"unresolved ${{{name}}} in {s!r}")
        return REF.sub(one, s)

    doc = yaml.safe_load(SRC.read_text(encoding="utf-8"))  # merge keys expand
    doc.pop("x-app-environment", None)
    services = {}
    for name, svc in doc["services"].items():
        if "image" in svc:
            svc["image"] = sub(svc["image"])
            if svc["image"].startswith(UPSTREAM_APP + ":"):
                svc["image"] = IMAGE
                # Every deploy takes the runner's newest push of the branch.
                svc["pull_policy"] = "always"
        env = svc.get("environment") or {}
        out = {}
        for k, v in env.items():
            if k.lower() in {"http_proxy", "https_proxy", "no_proxy"}:
                continue
            if v is None:
                if k in SET:
                    out[k] = SET[k]
                elif k in secret:
                    out[k] = "${%s}" % k
                continue  # an optional pass-through nobody sets here
            v = sub(str(v))
            if v == "" and k not in SET:
                continue
            out[k] = v
        if env:
            svc["environment"] = out
        if "healthcheck" in svc and "test" in svc["healthcheck"]:
            t = svc["healthcheck"]["test"]
            svc["healthcheck"]["test"] = sub(t) if isinstance(t, str) else [sub(x) for x in t]
        svc.pop("ports", None)  # nothing listens on the host's address but the door below
        if name in ("api", "worker"):
            reg = registry(dst.parent / "registry.yaml")
            apps = reg["apps"]
            env = svc.setdefault("environment", {})
            env["AGENTLOOM_REGISTRY"] = json.dumps({"title": reg["title"], "apps": apps},
                                                   separators=(",", ":"))
            if name == "api" and reg["requestUrl"]:
                env["AGENTLOOM_CONNECTOR_REQUEST_URL"] = reg["requestUrl"]
                env["AGENTLOOM_CONNECTOR_REQUEST_TOKEN"] = "${AGENTLOOM_CONNECTOR_REQUEST_TOKEN}"
            if corp:
                # Only these origins may be a private MCP endpoint; MCP_ALLOW_PRIVATE_ENDPOINT
                # stays off. Each registry app is on CORP too, so its origin joins them.
                own = [urlsplit(e["endpoint"])._replace(path="", query="", fragment="").geturl()
                       for e in apps]
                env["AGENTLOOM_PRIVATE_MCP_ORIGINS"] = ",".join(
                    dict.fromkeys([*CORP_PRIVATE_MCP_ORIGINS, *own]))
                if name == "api":
                    env["AGENTLOOM_MCP_CLIENT_ID"] = "${AGENTLOOM_MCP_CLIENT_ID}"
                    env["AGENTLOOM_MCP_CLIENT_SECRET"] = "${AGENTLOOM_MCP_CLIENT_SECRET}"
        services[name] = svc

    if corp:
        # corp-caddy terminates TLS and proxies the host's :80.
        services["web"]["ports"] = ["80:5173"]
    else:
        services["cloudflared"] = {
            "image": "cloudflare/cloudflared:2026.9.1@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4",
            "restart": "unless-stopped",
            "command": ["tunnel", "--no-autoupdate", "run"],
            "networks": list(services["web"].get("networks") or []),
            "environment": {"TUNNEL_TOKEN": "${TUNNEL_TOKEN}"},
            "depends_on": ["web"],
        }
    doc["services"] = services

    if corp:
        # agentloom-watch: our services beside upstream's (corp/watch/services.yaml).
        extra = yaml.safe_load((dst.parent / "watch" / "services.yaml").read_text(encoding="utf-8"))
        for key in ("services", "volumes", "networks"):
            clash = set(doc.get(key) or {}) & set(extra.get(key) or {})
            if clash:
                raise SystemExit(f"watch/services.yaml {key} clash with upstream's: {sorted(clash)}")
            doc.setdefault(key, {}).update(extra.get(key) or {})

    with open(dst, "w", encoding="utf-8") as f:
        f.write(header.format(origin=origin, tag=tag))
        yaml.safe_dump(doc, f, sort_keys=False, width=100, default_flow_style=False)
    print(f"wrote {dst.relative_to(HERE.parent)}")


FOOTER = """\
#
# Nothing is built here. The plane's local runner (agentloom/runner) builds upstream's
# infra/compose/Dockerfile and agentloom/Dockerfile from the agentloom branch and pushes
# the image to the registry on this host; api, worker, web and the supervisor all run it.
#
# Generated by agentloom/gen-compose.py from infra/compose/docker-compose.images.yml
# (upstream {tag}). Regenerate after every merge from upstream; never hand-edit.
"""
build("app.agentloom.com", APP, HERE / "compose.yaml", """\
# AgentLoom for customers, published at {origin} through its own Cloudflare
# tunnel, whose cloudflared runs here and reaches web:5173. No port is
# published on the host. Sign-in is email and password, with open sign-up.
""" + FOOTER, corp=False)
build("agentloom.corp.darkcompute.io", CORP, HERE / "corp" / "compose.yaml", """\
# AgentLoom for darkcompute, published at {origin} by corp-caddy, which
# proxies to this host's :80 (web, which same-origin-proxies /api and /rpc to api).
# Who gets in is authentik's decision: application AgentLoom (slug
# darkcompute-rakazo) and its binding. There is no password sign-in, and an
# account opens for whoever authentik sends back (OIDC_ALLOW_SIGNUP_BYPASS).
# watch-init, watch and watch-proxy are agentloom-watch (corp/watch): every routine
# on one page with a Stop, behind oauth2-proxy on :8091.
""" + FOOTER, corp=True)
