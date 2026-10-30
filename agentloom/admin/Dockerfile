# agentloom-watch (watch.py). One image for both jobs: `init` as the database
# owner on every deploy, `serve` as agentloom_watch behind oauth2-proxy.
FROM python:3.12-slim
RUN pip install --no-cache-dir "psycopg[binary]==3.2.3" \
 && mkdir /data && chown nobody /data
COPY watch.py init.sql /app/
USER nobody
CMD ["python3", "/app/watch.py", "serve"]
