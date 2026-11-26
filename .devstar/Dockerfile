FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY mining/requirements-baseline.txt /tmp/mining-requirements.txt
RUN python3 -m venv /opt/programbench && /opt/programbench/bin/pip install --no-cache-dir -r /tmp/mining-requirements.txt
ENV MINING_PYTHON=/opt/programbench/bin/python
COPY . .

ENTRYPOINT ["sh", ".devstar/entrypoint.sh"]
