"""Thin async-friendly Gemini JSON helpers shared by the swarm orchestrator.

The google-genai SDK is synchronous, so the heavy lifting here is:
  * a single lazily-built client (so the worker still starts without a key),
  * `chat_json` for one blocking JSON call with retry/backoff + timeout, and
  * `gather_json` to fan many calls out concurrently under a semaphore, each
    blocking call offloaded to a thread so the event loop stays free.

This generalises the inline google-genai usage in `suggest.py`/`personas.py` so
the easy-agent swarm doesn't duplicate prompt/parse/retry boilerplate.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
from typing import Any, Awaitable, Callable, Iterable, TypeVar

_client = None


def _get_client():
    """Build (once) and return a google-genai client, or raise if no key."""
    global _client
    if _client is not None:
        return _client
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set on the backend. Set it to run the agent "
            "swarm, or use MIROFISH_MOCK=1 for a deterministic LLM-free run."
        )
    # Imported lazily so the worker still starts without the dependency/key.
    from google import genai

    _client = genai.Client(api_key=api_key)
    return _client


def _extract_json(text: str) -> Any:
    """Parse a JSON object/array out of a model response (tolerates fences)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty model response")
    # Prefer the outermost {...}; fall back to [...] for array responses.
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        raise ValueError(f"no JSON found in response: {text[:200]!r}")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    if end < start:
        raise ValueError(f"unterminated JSON in response: {text[:200]!r}")
    return json.loads(text[start : end + 1])


def chat_json(
    prompt: str,
    *,
    model: str,
    temperature: float = 0.8,
    max_output_tokens: int = 2048,
    retries: int = 3,
) -> Any:
    """One blocking Gemini call returning parsed JSON. Retries transient errors."""
    client = _get_client()  # raises a friendly error if the key is missing
    from google.genai import types
    config = types.GenerateContentConfig(
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        response_mime_type="application/json",
        # Disable Gemini 2.5 "thinking" so JSON answers aren't truncated.
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        http_options=types.HttpOptions(
            timeout=int(os.getenv("GEMINI_TIMEOUT_MS", "120000"))
        ),
    )

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            resp = client.models.generate_content(
                model=model, contents=prompt, config=config
            )
            return _extract_json(resp.text or "")
        except Exception as err:  # noqa: BLE001 - retry any transient failure
            last_err = err
            if attempt < retries - 1:
                # Exponential backoff with jitter: ~2s, 4s, 8s.
                time.sleep(2 ** (attempt + 1) + random.uniform(0, 1))
    raise RuntimeError(f"Gemini call failed after {retries} attempts: {last_err}")


T = TypeVar("T")


async def gather_json(
    prompts: Iterable[str],
    *,
    model: str,
    concurrency: int,
    temperature: float = 0.8,
    max_output_tokens: int = 2048,
    on_error: Callable[[int, Exception], T] | None = None,
) -> list[Any]:
    """Run many `chat_json` calls concurrently, bounded by a semaphore.

    Each blocking SDK call is offloaded to a worker thread. Failures either
    propagate (default) or are replaced by `on_error(index, exc)` so one bad
    agent doesn't sink the whole run.
    """
    prompts = list(prompts)
    sem = asyncio.Semaphore(max(1, concurrency))

    async def _one(index: int, prompt: str) -> Any:
        async with sem:
            try:
                return await asyncio.to_thread(
                    chat_json,
                    prompt,
                    model=model,
                    temperature=temperature,
                    max_output_tokens=max_output_tokens,
                )
            except Exception as err:  # noqa: BLE001
                if on_error is not None:
                    return on_error(index, err)
                raise

    return await asyncio.gather(*(_one(i, p) for i, p in enumerate(prompts)))


async def run_with_timeout(coro: Awaitable[T], timeout_s: int) -> T:
    """Await `coro` but raise a clear RuntimeError if it exceeds the budget."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_s)
    except asyncio.TimeoutError as err:
        raise RuntimeError(
            f"Swarm run exceeded SWARM_TIMEOUT ({timeout_s}s). Lower "
            f"MAX_EASY_AGENT/AGENTS_PER_PRODUCT or raise SWARM_TIMEOUT."
        ) from err
