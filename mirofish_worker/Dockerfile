# ShopSim backend for Railway: FastAPI worker + real MiroFish on the Gemini API.
#
# Build context = this folder (set Railway's service root dir to mirofish_worker).
# Required env on Railway: GEMINI_API_KEY  (GEMINI_MODEL optional).
#
# Note: MiroFish pulls camel-ai/OASIS (torch, transformers), so the image is
# large and the first build takes several minutes.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy

# System deps: git to fetch MiroFish, build tooling for any native wheels.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*

# uv — used to build MiroFish into its own venv.
RUN pip install --no-cache-dir uv

# --- Build MiroFish (pinned) with the gemini-api provider overlay ---------------
ARG MIROFISH_COMMIT=3e98e776cdfc9556c12ace82a60e9d3da5bd41e7
RUN git clone https://github.com/amadad/mirofish-cli.git /opt/mirofish-cli \
  && git -C /opt/mirofish-cli checkout ${MIROFISH_COMMIT}

# Overlay our patch that adds LLM_PROVIDER=gemini-api (config.py + llm_client.py).
COPY mirofish_patches/app/ /opt/mirofish-cli/app/

# MiroFish loads its own .env with override=True, so pin the provider here.
# GEMINI_API_KEY / GEMINI_MODEL are NOT written here — they come from the
# container environment (Railway), so they are not overridden.
RUN printf 'LLM_PROVIDER=gemini-api\n' > /opt/mirofish-cli/.env

# Install MiroFish + the Gemini SDK into MiroFish's venv.
RUN cd /opt/mirofish-cli \
  && uv sync \
  && uv pip install --python /opt/mirofish-cli/.venv/bin/python google-genai

# --- Worker service -------------------------------------------------------------
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Chromium + OS deps for the checkout-friction simulator (checkout_sim.py).
RUN playwright install --with-deps chromium
COPY . .

ENV MIROFISH_BIN=/opt/mirofish-cli/.venv/bin/mirofish \
    MIROFISH_MOCK=0 \
    LLM_PROVIDER=gemini-api \
    GEMINI_MODEL=gemini-2.5-flash \
    MIROFISH_MAX_ROUNDS=4 \
    RUNS_DIR=/app/runs \
    PORT=8800

EXPOSE 8800
# Bind IPv6 (::) so the service is reachable over Railway private networking.
# On Linux this is dual-stack, so public access still works too.
CMD ["sh", "-c", "uvicorn app:app --host :: --port ${PORT:-8800}"]
