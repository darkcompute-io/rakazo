# The local runner

`agentloom-build-01` (DMZ) builds this branch and the app host only pulls.

- **Watch:** `build.sh` runs every minute (`agentloom-build.timer`) and compares the branch head with the last commit it built.
- **Build:** on a new commit it builds upstream's `infra/compose/Dockerfile`, then `agentloom/Dockerfile` on top. Docker keeps the cache, so a typical change rebuilds only what changed.
- **Push:** it pushes `10.56.10.48:5000/agentloom-app:<commit>` and `:agentloom` to the registry on the app host. That registry accepts this guest and nothing else.
- **Deploy:** with a deploy-only Coolify token in `/etc/agentloom-build/env`, it then calls Coolify's deploy. Coolify pulls `127.0.0.1:5000/agentloom-app:agentloom` and restarts.

Only this branch is ever built, never a pull request.

## Install

```bash
install -m 0755 agentloom/runner/build.sh /usr/local/sbin/agentloom-build
install -m 0644 agentloom/runner/agentloom-build.service agentloom/runner/agentloom-build.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentloom-build.timer
journalctl -u agentloom-build -f          # watch a build
```

`/etc/agentloom-build/env` (mode 600):

```
COOLIFY_URL=https://coolify.dmz.darkcompute.io
COOLIFY_APP=<application uuid>
COOLIFY_DEPLOY_TOKEN=<a token with the deploy permission only>
```
