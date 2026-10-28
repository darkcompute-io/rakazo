# AgentLoom for customers

**app.agentloom.com.** This repository is our copy of
[elie222/rakazo](https://github.com/elie222/rakazo), and this directory is
everything that makes it AgentLoom. Outside `agentloom/`, every file is upstream's
or a change we chose to make to it.

## The name

The source keeps upstream's name, so pulling upstream never conflicts over
it. The name people see is put on at build time by `agentloom/Dockerfile`. It
rewrites every capitalised `Rakazo` in the built web bundle, and the build fails
if one survives. Messages the api or a bot writes can still say Rakazo.

## Pulling upstream's fixes

```bash
git remote add upstream https://github.com/elie222/rakazo.git   # once
git fetch upstream --tags
git merge <tag>            # a release tag, e.g. v0.3.6, rather than upstream/main
python3 agentloom/gen-compose.py <tag>
git commit -am "merge upstream <tag>"
```

Read the release's self-host notes for new required names first. A new
secret goes in the deployer's env before the merge is deployed.

## How it runs

`agentloom/compose.yaml` is generated, so don't hand-edit it.

- **Image:** `app-base` builds upstream's `infra/compose/Dockerfile` unchanged, and `agentloom/Dockerfile` puts the name on it. api, worker and web run that one image.
- **Sign-in:** email and password, with open sign-up.
- **Computers:** E2B (`SANDBOX_PROVIDER=e2b`). The docker supervisor and its docker socket are dropped.
- **The way in:** cloudflared reaches `web:5173`, and no port is published.

It is deployed by Coolify, with base directory `/` and compose file
`agentloom/compose.yaml`.

## Actions

GitHub Actions are off for this repository. Upstream's workflows (CI, image
publish, mobile builds) would otherwise run here on every push.
