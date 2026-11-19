FROM docker:29.3.0-cli@sha256:067c301efe497cd5d174d468b7b3422a485ae4aca8f7ec1ffd4655c9fa383af2 AS docker-cli
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /workspace
COPY mining/requirements-baseline.txt /tmp/mining-requirements.txt
RUN python3 -m venv /opt/programbench \
    && for attempt in 1 2 3; do \
        /opt/programbench/bin/pip install --timeout 120 --retries 3 --progress-bar off -r /tmp/mining-requirements.txt && break; \
        test "$attempt" -lt 3 || exit 1; \
        sleep 5; \
    done \
    && rm -rf /root/.cache/pip
ENV MINING_PYTHON=/opt/programbench/bin/python
COPY . .

ENTRYPOINT ["sh", ".devstar/entrypoint.sh"]
