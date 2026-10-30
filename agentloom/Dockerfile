# AgentLoom's image: upstream's own image (infra/compose/Dockerfile, built
# unchanged as the `base` context by compose.yaml's app-base service) with the
# name it shows people changed to AgentLoom.
#
# Only the built web bundle is touched: every capitalised "Rakazo" in dist/ is
# display text (the code's own identifiers are lowercase), source maps are left
# alone, and file names and hashes do not move. The source tree keeps upstream's
# name on purpose, so pulling upstream never conflicts over it.
FROM base
USER root
RUN cd /app/apps/web/dist \
 && find . -type f \( -name '*.js' -o -name '*.html' -o -name '*.webmanifest' \) \
      -exec sed -i 's/Rakazo/AgentLoom/g' {} + \
 && grep -q '<title>AgentLoom</title>' index.html \
 && ! grep -rl --exclude='*.map' Rakazo .
# Umami pageviews for app.agentloom.com (darkcompute deploy/analytics/sites.yaml).
# An external script, not inline, so the CSP's script-src needs only the
# collector's origin, which gen-compose.py sets as RAKAZO_CSP_SCRIPT_SRC and
# RAKAZO_CSP_CONNECT_SRC. data-domains keeps local and preview builds out.
RUN cd /app/apps/web/dist \
 && sed -i 's#</head>#<script defer src="https://a.darkcompute.io/assets/app.js" data-website-id="bc1a2af4-3ec1-4bae-a690-293f5cf4afbd" data-host-url="https://a.darkcompute.io" data-domains="app.agentloom.com"></script></head>#' index.html \
 && grep -q 'bc1a2af4-3ec1-4bae-a690-293f5cf4afbd' index.html
USER node
