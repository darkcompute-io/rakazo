#!/usr/bin/env python3
"""agentloom/compose.yaml from this repository's own infra/compose/docker-compose.images.yml.

Upstream's published-images compose, with what AgentLoom for customers decides:
the app image is BUILT here from this tree (upstream's Dockerfile, then
agentloom/Dockerfile for the name), sign-in is email and password with open
sign-up, a bot's computer is a container on this host behind Rakazo's egress lock, and
cloudflared is the only way in.

    python3 agentloom/gen-compose.py <upstream-tag>

Run it after every merge from upstream, and commit what it writes.
"""
import re, sys
from pathlib import Path
import yaml

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "infra" / "compose" / "docker-compose.images.yml"
DST = HERE / "compose.yaml"
tag = sys.argv[1]
HOST = "app.agentloom.com"
ORIGIN = f"https://{HOST}"
IMAGE = "agentloom-app:local"
UPSTREAM_APP = "ghcr.io/elie222/rakazo/app"
# What this deployment decides. Everything else takes upstream's own default.
SET = {
    "RAKAZO_IMAGE": UPSTREAM_APP,
    "RAKAZO_IMAGE_TAG": tag,
    "RAKAZO_COMPUTER_IMAGE_TAG": tag,
    "BETTER_AUTH_URL": ORIGIN,
    "WEB_ORIGIN": ORIGIN,
    "API_URL": ORIGIN,
    "RAKAZO_HOST": HOST,
    # Customers are never in our IdP: email and password, open sign-up.
    "AUTH_PASSWORD_ENABLED": "true",
    "AUTH_BREACHED_PASSWORD_CHECK_ENABLED": "true",
    "SIGNUPS_ENABLED": "true",
    # A bot's computer is a container on this host, which is a VM (an escape stays in
    # it), and restricted egress gives computers the public internet and nothing
    # private: run infra/compose/restrict-computer-egress.sh on the host once.
    "SANDBOX_PROVIDER": "docker",
    "SANDBOX_COMPUTER_EGRESS": "restricted",
    # The host resolves through a private DMZ resolver, which the lock blocks.
    "SANDBOX_COMPUTER_DNS": "1.1.1.1,9.9.9.9",
    # Auto Review on for everyone who has not chosen: the deployment's model judges a
    # fetch to a new site instead of stopping to ask, which a sub-agent cannot do.
    "RAKAZO_AUTO_REVIEW": "true",
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
# Values the deployer holds. Named here, never written.
SECRET = {"POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY",
          "SCREEN_PROXY_SECRET", "SANDBOX_SUPERVISOR_TOKEN",
          "EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "GITEA_ADMIN_PASSWORD",
          # The deployment-wide model: a run with no key of its own uses this one.
          "OPENROUTER_API_KEY"}
# Nothing of upstream's is dropped since computers run here.
DROP: set[str] = set()
REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])((?:[^{}]|\{[^{}]*\})*))?\}")


def sub(s: str) -> str:
    def one(m):
        name, op, arg = m.group(1), m.group(2), m.group(3) or ""
        if name in SECRET:
            return "${%s}" % name
        if name in SET:
            return SET[name]
        if op == "-":
            return sub(arg)
        raise SystemExit(f"unresolved ${{{name}}} in {s!r}")
    return REF.sub(one, s)


doc = yaml.safe_load(SRC.read_text(encoding="utf-8"))  # merge keys expand
doc.pop("x-app-environment", None)
for name in DROP:
    doc["services"].pop(name)

# Upstream's image, built from this tree exactly as its own CI builds it.
services = {"app-base": {
    "build": {"context": "..", "dockerfile": "infra/compose/Dockerfile", "args": {"GIT_SHA": tag}},
    "image": "agentloom-app-base:local",
    "command": ["true"],
    "network_mode": "none",
    "restart": "no",
}}
for name, svc in doc["services"].items():
    deps = svc.get("depends_on")
    if isinstance(deps, dict):
        for d in DROP:
            deps.pop(d, None)
    elif isinstance(deps, list):
        svc["depends_on"] = [d for d in deps if d not in DROP]
    if "image" in svc:
        svc["image"] = sub(svc["image"])
        if svc["image"].startswith(UPSTREAM_APP + ":"):
            svc["image"] = IMAGE
            # api builds the image and the others run it: a build named on every
            # service exported the same 3.66 GB image three times (about 2 min each).
            if name == "api":
                svc["build"] = {"context": ".", "dockerfile": "Dockerfile",
                                "additional_contexts": {"base": "service:app-base"}}
                svc["pull_policy"] = "build"
            else:
                svc["pull_policy"] = "never"
    env = svc.get("environment") or {}
    out = {}
    for k, v in env.items():
        if k.lower() in {"http_proxy", "https_proxy", "no_proxy"}:
            continue
        if v is None:
            if k in SET:
                out[k] = SET[k]
            elif k in SECRET:
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
    svc.pop("ports", None)  # nothing listens on the host's address; cloudflared is the door
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

services["cloudflared"] = {
    "image": "cloudflare/cloudflared:2026.9.1@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4",
    "restart": "unless-stopped",
    "command": ["tunnel", "--no-autoupdate", "run"],
    "networks": list(services["web"].get("networks") or []),
    "environment": {"TUNNEL_TOKEN": "${TUNNEL_TOKEN}"},
    "depends_on": ["web"],
}
doc["services"] = services

HEADER = f"""\
# AgentLoom for customers, published at {ORIGIN} through its own Cloudflare
# tunnel, whose cloudflared runs here and reaches web:5173. No port is
# published on the host.
#
# Built from this repository: app-base is upstream's infra/compose/Dockerfile,
# unchanged; agentloom/Dockerfile puts the AgentLoom name on it; api, worker
# and web all run that one image.
#
# Generated by agentloom/gen-compose.py from infra/compose/docker-compose.images.yml
# (upstream {tag}). Regenerate after every merge from upstream; never hand-edit.
"""
with open(DST, "w", encoding="utf-8") as f:
    f.write(HEADER)
    yaml.safe_dump(doc, f, sort_keys=False, width=100, default_flow_style=False)
print(f"wrote {DST.relative_to(HERE.parent)}")
