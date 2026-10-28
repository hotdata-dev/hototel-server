# hototel server: ingest + admin dashboard, all state in hotdata.
FROM python:3.12-slim

# The base tag lags Debian security updates, so upgrade in place rather than
# ship whatever it last froze. urllib3 is floored because `pip install
# hotdata` accepts versions with known CVEs. duckdb is floored for the same
# reason and against nothing: no dependency here asks for it, so an unpinned
# `duckdb` is whatever PyPI served the day the layer was built, and 1.4.0-1.4.1
# were current long enough to be baked in. Those carry CVE-2025-64429, where
# the encryption path skips the return code of OpenSSL's rand_bytes() and
# cannot tell a failed generator from a good one; 1.4.2 checks it. The floor,
# not a pin, so the build keeps taking later releases.
# pip is removed once it has done its job: nothing at runtime needs it, and its
# vendored copies of msgpack and setuptools are scanner findings of their own.
# hotdata-langchain[agents] + langchain-anthropic/openai back the Insights
# page; the server boots without them (the page says it is off), but the
# image carries them so an operator only has to set the model env vars.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir hotdata 'duckdb>=1.4.2' 'urllib3>=2.8.0' \
        "hotdata-langchain[agents]" langchain-anthropic langchain-openai && \
    pip uninstall -y pip && \
    useradd --create-home --uid 10001 appuser

WORKDIR /app
COPY core.py ./
COPY server/ server/

USER 10001

# Config via env: HOTDATA_API_KEY (required), HOTUSAGE_INGEST_TOKEN (required
# outside dev; its value is not itself a credential unless
# HOTUSAGE_ALLOW_SHARED_INGEST=1), HOTDATA_WORKSPACE / HOTDATA_API_HOST
# optional overrides. The Insights page needs a model: HOTOTEL_INSIGHTS_BASE_URL +
# HOTOTEL_INSIGHTS_API_KEY for the Modal deployment (modal/hototel_llm.py), or
# ANTHROPIC_API_KEY for the Anthropic API. HOTOTEL_INSIGHTS_MODEL overrides the
# model name; HOTOTEL_INSIGHTS=0 forces the page off.

# This image only ever runs behind App Runner, which rewrites X-Forwarded-For,
# so the rate limiter may believe it here. A bare `python3 server.py` gets the
# safe default instead, where that header is whatever the caller typed.
ENV HOTUSAGE_TRUSTED_PROXY=1

EXPOSE 8377
CMD ["python3", "server/server.py", "--host", "0.0.0.0", "--port", "8377"]
