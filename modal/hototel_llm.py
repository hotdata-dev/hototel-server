"""hototel's own model endpoint on Modal: an open-weight model behind vLLM's
OpenAI-compatible API, which the Insights page talks to through LangChain's
ChatOpenAI instead of the Anthropic API.

Why this exists: the Insights agent reads usage rows -- who worked on what,
session titles, machine names -- and sends them to a model. Serving the model
here keeps that inside the company's own Modal account rather than a third
party's API, and bills by GPU-second while a container is up rather than by
token.

Deploy once (Modal CLI signed in):

    modal secret create hototel-llm HOTOTEL_LLM_API_KEY=<random string>
    modal deploy modal/hototel_llm.py

then give the server the URL `modal deploy` prints (the "flash service endpoint")
plus that key:

    export HOTOTEL_INSIGHTS_BASE_URL=https://<workspace>--hototel-server.<region>.modal.direct/v1
    export HOTOTEL_INSIGHTS_API_KEY=<the same random string>

The container scales to zero after SCALEDOWN minutes idle. The first request
after that waits for a cold start -- a minute or two with the weights already
in the volume, longer the very first time while they download.

Model: Qwen3-30B-A3B-Instruct-2507, a mixture-of-experts model with 3B active
parameters per token. It is chosen for this workload over a dense 32B: the
agent loop is many short model turns each followed by a SQL round trip, so
tokens per second matters more than peak reasoning, and it is one of the
stronger open models at tool calling. Apache 2.0, no Hugging Face gate.
"""

import os

import modal

MINUTES = 60
VLLM_PORT = 8000
N_GPU = 1
SCALEDOWN = 10 * MINUTES

MODEL_NAME = "Qwen/Qwen3-30B-A3B-Instruct-2507"
# Pinned so a repo update upstream cannot change what answers questions here.
MODEL_REVISION = "0d7cf23991f47feeb3a57ecb4c9cee8ea4a17bfe"
# The short alias the server addresses it by, so the model can be swapped
# here without touching HOTOTEL_INSIGHTS_MODEL on the hototel server.
SERVED_NAME = "hototel"

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.21.0")
    .env({
        "HF_XET_HIGH_PERFORMANCE": "1",
        # Stay on the prebuilt Triton MoE kernels. Left to itself vLLM picks
        # FlashInfer's CUTLASS MoE for this model and JIT-compiles it with
        # ninja on first run, which took longer than Modal's startup timeout
        # and killed the container before it ever served a request.
        "VLLM_USE_FLASHINFER_MOE_FP16": "0",
    })
)

hf_cache_vol = modal.Volume.from_name("hototel-hf-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("hototel-vllm-cache", create_if_missing=True)

app = modal.App("hototel")


@app.server(
    image=vllm_image,
    gpu=f"H100:{N_GPU}",
    scaledown_window=SCALEDOWN,
    # Weights come off the volume at boot. Measured: ~3 minutes on a good
    # day, but the volume's 9P mount has read the 57GB at ~60MB/s, which is
    # 17 minutes -- a 15-minute limit killed that boot and the page saw only
    # 503s. The limit is generous so a slow read finishes rather than restarts;
    # the prefetch flag below is what makes it fast.
    startup_timeout=30 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
    secrets=[modal.Secret.from_name("hototel-llm")],
    port=VLLM_PORT,
    target_concurrency=16,            # agent runs are few; 16 is plenty per replica
    # Modal's own proxy auth is off because vLLM authenticates the request
    # itself: VLLM_API_KEY (set in start) makes every call carry a Bearer
    # token, the one shape every OpenAI-compatible client already sends.
    unauthenticated=True,
)
class Server:
    @modal.enter()
    def start(self):
        import subprocess

        api_key = os.environ.get("HOTOTEL_LLM_API_KEY", "")
        if not api_key:
            raise RuntimeError("secret hototel-llm must define HOTOTEL_LLM_API_KEY")
        cmd = [
            "vllm", "serve", MODEL_NAME,
            "--revision", MODEL_REVISION,
            "--served-model-name", SERVED_NAME, MODEL_NAME,
            "--host", "0.0.0.0", "--port", str(VLLM_PORT),
            "--uvicorn-log-level=info",
            "--tensor-parallel-size", str(N_GPU),
            # The agent's whole transcript -- system prompt, tool schemas and
            # every query result of the run -- has to fit, plus the answer. A
            # takeaways run overflowed 32k (25k of prompt once a dozen result
            # sets were in it, with 8k reserved to answer), so 64k. The model
            # supports 262k natively; KV cache for 64k is a few GB of the
            # ~15GB left beside the weights on one H100.
            "--max-model-len", "65536",
            "--gpu-memory-utilization", "0.92",
            # read the safetensors shards with parallel threads into the page
            # cache before mapping them: the volume is a network filesystem
            # (9P) whose single-stream reads are latency-bound, and vLLM only
            # prefetches on its own for NFS/Lustre
            "--safetensors-load-strategy", "prefetch",
            # tool calling: Qwen3 writes Hermes-style <tool_call> blocks
            "--enable-auto-tool-choice",
            "--tool-call-parser", "hermes",
        ]
        print(*cmd)
        # The key goes in through the environment, not --api-key: vLLM echoes
        # its non-default arguments to the log at boot, and those lines land
        # in Modal's log store, where a flag value would sit in plain text.
        self.process = subprocess.Popen(cmd, env={**os.environ, "VLLM_API_KEY": api_key})

    @modal.exit()
    def stop(self):
        self.process.terminate()


@app.local_entrypoint()
def test(content: str = "Reply with the single word: ready"):
    """`modal run modal/hototel_llm.py` -- wait for the server and ask it one
    thing, with a tool offered, to prove tool calling is wired."""
    import json
    import time
    import urllib.error
    import urllib.request

    url = Server.get_url()
    key = os.environ.get("HOTOTEL_INSIGHTS_API_KEY") or input("HOTOTEL_LLM_API_KEY: ")
    deadline = time.time() + 15 * MINUTES
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "/health", timeout=30) as r:
                if r.status == 200:
                    break
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(5)
    else:
        raise SystemExit(f"{url} never became healthy")
    print(f"healthy: {url}")
    body = {
        "model": SERVED_NAME,
        "messages": [{"role": "user", "content": content}],
        "tools": [{"type": "function", "function": {
            "name": "run_sql", "description": "Run SQL",
            "parameters": {"type": "object", "properties": {"sql": {"type": "string"}},
                           "required": ["sql"]}}}],
        "max_tokens": 200,
    }
    req = urllib.request.Request(url + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        out = json.load(r)
    msg = out["choices"][0]["message"]
    print("answer:", msg.get("content"))
    print("tool_calls:", msg.get("tool_calls"))
