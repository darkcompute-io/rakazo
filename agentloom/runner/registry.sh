#!/bin/bash
# The image registry on an AgentLoom instance's host, which only that plane's
# runner may reach. Run once on the host, as root:
#
#     agentloom/runner/registry.sh <runner address>
#
# registry:2 on :5000, and a DOCKER-USER rule (agentloom-registry-guard.service)
# that drops :5000 on eth0 from anyone but the runner. The host's own compose
# pulls 127.0.0.1:5000, which docker trusts without TLS.
set -euo pipefail
RUNNER=${1:?runner address}
[[ $RUNNER =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not an address: $RUNNER" >&2; exit 1; }

rule="-i eth0 -p tcp --dport 5000 ! -s $RUNNER -j DROP"
cat >/etc/systemd/system/agentloom-registry-guard.service <<UNIT
[Unit]
Description=Only $RUNNER may reach the image registry on :5000
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c "iptables -C DOCKER-USER $rule 2>/dev/null || iptables -I DOCKER-USER 1 $rule"
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agentloom-registry-guard.service

docker inspect agentloom-registry >/dev/null 2>&1 ||
  docker run -d --name agentloom-registry --restart always -p 5000:5000 \
    -e REGISTRY_STORAGE_DELETE_ENABLED=true -v agentloom-registry:/var/lib/registry registry:2.8.3
iptables -C DOCKER-USER $rule && echo "registry up, :5000 open to $RUNNER only"
