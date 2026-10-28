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
USER node
