"""Variant suggestion via the Gemini API.

Lives on the backend so the Shopify frontend never holds an LLM key. Given a
component's current editable fields, it rewrites them for higher conversion and
returns the same keys.
"""
from __future__ import annotations

import json
import os


def suggest_variant(
    component_type: str, title: str, baseline: dict[str, str]
) -> dict[str, str]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set on the backend. Set it to enable AI "
            "variant suggestions, or write Variant B manually."
        )

    # Imported lazily so the worker still starts without the dependency.
    from google import genai
    from google.genai import types

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    keys = list(baseline.keys())

    prompt = (
        "You are a conversion copywriter for a Shopify store.\n"
        f"Rewrite the following {component_type} fields to increase shopper "
        "purchase intent while staying truthful and on-brand. Keep roughly the "
        "same length.\n\n"
        f"Current values (JSON):\n{json.dumps(baseline, indent=2)}\n\n"
        f"Return ONLY a JSON object with exactly these keys: {', '.join(keys)}."
    )

    client = genai.Client(api_key=api_key)
    resp = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.8,
            max_output_tokens=2048,
            response_mime_type="application/json",
            # Disable Gemini 2.5 "thinking" so the JSON answer isn't truncated.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            http_options=types.HttpOptions(
                timeout=int(os.getenv("GEMINI_TIMEOUT_MS", "120000"))
            ),
        ),
    )
    text = resp.text or ""

    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise RuntimeError("Variant model did not return JSON.")
    parsed = json.loads(text[start : end + 1])

    return {
        k: (parsed[k] if isinstance(parsed.get(k), str) else baseline[k])
        for k in keys
    }
