# hototel server: ingest + admin dashboard, all state in hotdata.
FROM python:3.12-slim

# The base tag lags Debian security updates, so upgrade in place rather than
# ship whatever it last froze. urllib3 is floored because `pip install
# hotdata` accepts versions with known CVEs. pip is removed once it has done
# its job: nothing at runtime needs it, and its vendored copies of msgpack and
# setuptools are scanner findings of their own.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir hotdata duckdb 'urllib3>=2.8.0' && \
    pip uninstall -y pip && \
    useradd --create-home --uid 10001 appuser

WORKDIR /app
COPY core.py ./
COPY server/ server/

USER 10001

# Config via env: HOTDATA_API_KEY (required), HOTUSAGE_INGEST_TOKEN (required
# outside dev; its value is not itself a credential unless
# HOTUSAGE_ALLOW_SHARED_INGEST=1), HOTDATA_WORKSPACE / HOTDATA_API_HOST
# optional overrides.

# This image only ever runs behind App Runner, which rewrites X-Forwarded-For,
# so the rate limiter may believe it here. A bare `python3 server.py` gets the
# safe default instead, where that header is whatever the caller typed.
ENV HOTUSAGE_TRUSTED_PROXY=1

EXPOSE 8377
CMD ["python3", "server/server.py", "--host", "0.0.0.0", "--port", "8377"]
