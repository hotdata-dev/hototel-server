# hototel server: ingest + admin dashboard, all state in hotdata.
FROM python:3.12-slim

# hotdata-langchain[agents] + langchain-anthropic back the Insights page; the
# server boots without them (the page says it is off), but the image
# carries them so setting ANTHROPIC_API_KEY is all that turns it on.
RUN pip install --no-cache-dir hotdata duckdb \
        "hotdata-langchain[agents]" langchain-anthropic langchain-openai && \
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
