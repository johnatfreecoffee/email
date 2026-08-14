# Agent Mail cloud box — same worker, in a VM.
# Privileged: this container can clone repos and run Grok against them.
# Do not expose it to the public internet.

FROM python:3.13-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agentmail
COPY worker.py access.py docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV AGENTMAIL_HOME=/data \
    AGENTMAIL_VIA=box \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
