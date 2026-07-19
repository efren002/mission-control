FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git curl ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 runner

USER runner
WORKDIR /workspace

ENTRYPOINT ["/bin/bash", "-lc"]

