# The local runners

Each instance's plane has its own runner, because CORP and DMZ cannot reach each
other. Both build the same commit of this branch, and neither app host builds.

| instance | runner | registry on | Coolify |
|---|---|---|---|
| app.agentloom.com (DMZ) | `agentloom-build-01` | `agentloom-app-02`, `10.56.10.48:5000` | dmz-coolify |
| agentloom.corp.darkcompute.io (CORP) | `ci-runner` | `agentloom-corp-01`, `10.56.30.100:5000` | corp-coolify |

- **Watch:** `build.sh` runs every minute (`agentloom-build.timer`) and compares the branch head with the last commit it built.
- **Build:** on a new commit it builds upstream's `infra/compose/Dockerfile`, then `agentloom/Dockerfile` on top. Docker keeps the cache, so a typical change rebuilds only what changed.
- **Push:** it pushes `<registry>/agentloom-app:<commit>` and `:agentloom` to the registry on its app host. That registry accepts its runner and nothing else (`registry.sh`).
- **Deploy:** with a deploy-only Coolify token in `/etc/agentloom-build/env`, it then calls Coolify's deploy. Coolify pulls `127.0.0.1:5000/agentloom-app:agentloom` and restarts.

Only this branch is ever built, never a pull request.

## Install

On the app host, once:

```bash
agentloom/runner/registry.sh <runner address>
```

On the runner, with `"insecure-registries": ["<registry>"]` in `/etc/docker/daemon.json`:

```bash
install -m 0755 agentloom/runner/build.sh /usr/local/sbin/agentloom-build
install -m 0644 agentloom/runner/agentloom-build.service agentloom/runner/agentloom-build.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentloom-build.timer
journalctl -u agentloom-build -f          # watch a build
```

`/etc/agentloom-build/env` (mode 600), read as data and never sourced:

```
AGENTLOOM_REGISTRY=10.56.30.100:5000
COOLIFY_URL=https://coolify.corp.darkcompute.io
COOLIFY_APP=<application uuid>
COOLIFY_DEPLOY_TOKEN=<a token with the deploy permission only>
COOLIFY_ADDR=<Coolify's address, where this guest cannot resolve its name>
```
