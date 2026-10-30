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
import re, sys
from pathlib import Path
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
# Projects: Gitea and its MCP server beside the app, on the internal data network only.
PROJECTS_ENV = {
    "GITEA_URL": "http://gitea:3000",
    "GITEA_ADMIN_USER": "agentloom",
    "GITEA_ADMIN_PASSWORD": "${GITEA_ADMIN_PASSWORD}",
    "GITEA_MCP_URL": "http://gitea-mcp:8080/mcp",
    # Only this origin may be a private MCP endpoint; MCP_ALLOW_PRIVATE_ENDPOINT stays off.
    "AGENTLOOM_PRIVATE_MCP_ORIGINS": "http://gitea-mcp:8080",
}
GITEA_IMAGE = "docker.gitea.com/gitea:1.24.6-rootless@sha256:91f2b27e080739f0d19dba716c3214f17257c632cf762e545b44ca577e37052c"
GITEA_MCP_IMAGE = "docker.gitea.com/gitea-mcp-server@sha256:ccdb5660ecdf54c5e480f10cc8120ba2bf150b582cea8a1974de2e59883582d3"
# The repo and file tools a bot needs, and nothing else (no pull requests, wiki or Gitea's own
# kanban "projects", which would be confused with ours). Mirrored in apps/api/src/routes/projects.ts.
GITEA_TOOLS = "create_repo,list_my_repos,get_repository_tree,get_file_contents,get_dir_contents,create_or_update_file,list_commits"
# Values the deployer holds. Named here, never written; a name an instance's deployer
# does not hold is empty there.
SECRET = {"POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY",
          "SCREEN_PROXY_SECRET", "SANDBOX_SUPERVISOR_TOKEN",
          "EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "GITEA_ADMIN_PASSWORD",
          # The deployment-wide model: a run with no key of its own uses this one.
          "OPENROUTER_API_KEY",
          # Connect apps: Composio holds each member's app logins (Gmail, Slack, ...).
          "COMPOSIO_API_KEY"}
# corp's only: the authentik client, and agentloom-watch's.
CORP_SECRET = {"OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "WATCH_DB_PASSWORD", "WATCH_OIDC_CLIENT_ID",
               "WATCH_OIDC_CLIENT_SECRET", "WATCH_COOKIE_SECRET"}
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
            svc.setdefault("environment", {}).update(PROJECTS_ENV)
        services[name] = svc

    gitea_volumes = ["giteadata:/var/lib/gitea", "giteaconfig:/etc/gitea"]
    gitea_env = {
        "GITEA__security__INSTALL_LOCK": "true",
        "GITEA__service__DISABLE_REGISTRATION": "true",
        "GITEA__service__REQUIRE_SIGNIN_VIEW": "true",
        "GITEA__database__DB_TYPE": "sqlite3",
        "GITEA__server__ROOT_URL": "http://gitea:3000/",
        "GITEA__server__OFFLINE_MODE": "true",
        "GITEA__repository__DEFAULT_PRIVATE": "private",
        # Coolify adds every service to its own network too, so Gitea can reach out at the
        # network level; close every way it would: migrations, mirrors and webhooks.
        "GITEA__repository__DISABLE_MIGRATIONS": "true",
        "GITEA__mirror__ENABLED": "false",
        "GITEA__webhook__ALLOWED_HOST_LIST": "loopback",
    }
    services["gitea"] = {
        "image": GITEA_IMAGE,
        "restart": "unless-stopped",
        "environment": gitea_env,
        "volumes": gitea_volumes,
        "networks": ["data"],
    }
    # Makes the admin account the api acts through, once; a rerun finds it and stops.
    services["gitea-init"] = {
        "image": GITEA_IMAGE,
        "restart": "no",
        "environment": {**gitea_env, "GITEA_ADMIN_PASSWORD": "${GITEA_ADMIN_PASSWORD}"},
        "volumes": gitea_volumes,
        "networks": ["data"],
        "depends_on": ["gitea"],
        "entrypoint": ["/bin/sh", "-c"],
        "command": [
            "for i in $$(seq 60); do gitea admin user list >/dev/null 2>&1 && break; sleep 2; done; "
            "gitea admin user list | grep -qw agentloom || gitea admin user create --admin "
            "--username agentloom --email admin@agentloom.local --password \"$$GITEA_ADMIN_PASSWORD\" "
            "--must-change-password=false"
        ],
    }
    services["gitea-mcp"] = {
        "image": GITEA_MCP_IMAGE,
        "restart": "unless-stopped",
        "command": ["/app/gitea-mcp", "-t", "http", "--port", "8080", "-H", "http://gitea:3000"],
        "environment": {"GITEA_TOOLS": GITEA_TOOLS},
        "networks": ["data"],
        "depends_on": ["gitea"],
    }
    doc.setdefault("volumes", {}).update({"giteadata": None, "giteaconfig": None})

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
