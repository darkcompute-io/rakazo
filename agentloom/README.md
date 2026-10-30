# AgentLoom

**app.agentloom.com** for customers, and **agentloom.corp.darkcompute.io** for us:
one branch, one image, two instances. This repository is our copy of
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

`agentloom/gen-compose.py <tag>` writes both composes, so don't hand-edit either.

| | `compose.yaml` (DMZ) | `corp/compose.yaml` (CORP) |
|---|---|---|
| Name | app.agentloom.com | agentloom.corp.darkcompute.io |
| Sign-in | email and password, open sign-up | authentik only (slug `darkcompute-rakazo`) |
| Way in | cloudflared, no host port | corp-caddy to the host's `:80` |
| Computers | docker, behind Rakazo's egress lock | docker |
| Extra | | agentloom-watch (`corp/watch`) on `:8091` |

- **Image:** each plane's runner builds this branch (`runner/`) and pushes to the registry on its app host; api, worker, web and the supervisor run it.
- **Projects:** Gitea and its MCP server run beside the app on the internal network, in both.
- **Deploy:** Coolify on each plane, from this repository's `agentloom` branch, base directory `/agentloom` (DMZ) or `/agentloom/corp` (CORP), compose file `/compose.yaml`. The runner calls the deploy; a push alone deploys nothing.

## Actions

GitHub Actions are off for this repository. Upstream's workflows (CI, image
publish, mobile builds) would otherwise run here on every push.
