"""Synthetic shopper personas seeded into the simulation.

Given a small "audience brief" derived from the store, produce a markdown
"## Target shoppers" section. MiroFish extracts entities from this text, so the
agents it generates become realistic prospective buyers rather than generic
social-media personas.

Gemini-generated when a key is available; otherwise a deterministic template so
mock runs (and key-less environments) still get shopper-like agents for free.
"""
from __future__ import annotations

import json
import os


def _price_tier(brief: dict) -> str:
    low, high, cur = brief.get("priceLow"), brief.get("priceHigh"), brief.get("currency") or ""
    if low is None or high is None:
        return "unknown"
    if low == high:
        return f"~{low:.0f} {cur}".strip()
    return f"{low:.0f}–{high:.0f} {cur}".strip()


def _template_section(brief: dict, count: int) -> str:
    brand = brief.get("brandName") or "this store"
    cats = ", ".join(brief.get("categories") or []) or "its products"
    tier = _price_tier(brief)
    voice = brief.get("brandVoice") or ""

    archetypes = [
        ("Bargain hunter",
         f"price-sensitive, compares {brand} against cheaper alternatives",
         "getting the best value", "high",
         f"whether it's worth the price ({tier})"),
        ("Gift buyer",
         f"buying {cats} as a gift for someone else",
         "finding something the recipient will love", "medium",
         "presentation, and whether it can be returned/exchanged"),
        ("Quality-focused researcher",
         "reads descriptions and reviews carefully before buying",
         "durability and that the product matches its claims", "low",
         "whether materials/specs live up to the copy"),
        ("Brand loyalist",
         f"already likes {brand}'s style and has bought before",
         "staying with a brand they trust", "low-medium",
         "whether a change still feels on-brand"),
        ("Skeptical first-timer",
         f"has never heard of {brand}",
         "deciding whether the store is trustworthy at all", "medium",
         "site credibility, shipping times, and the returns policy"),
        ("Impulse buyer",
         f"browses {cats} casually and decides fast",
         "an emotional, in-the-moment purchase", "low",
         "buyer's remorse — do they actually need it"),
    ]

    lines = ["## Target shoppers"]
    if voice:
        lines.append(f"_Store voice: {voice}_")
    lines.append(
        f"Realistic prospective shoppers of {brand} (categories: {cats}; "
        f"typical price {tier}). Each evaluates products as a buying decision."
    )
    for label, ctx, motive, budget, objection in archetypes[: max(1, count)]:
        lines.append(
            f"- **{label}** — {ctx}. Motivation: {motive}. "
            f"Budget sensitivity: {budget}. Likely objection: {objection}."
        )
    return "\n".join(lines)


def _gemini_section(brief: dict, count: int) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    prompt = (
        "You are a market researcher. Based on this Shopify store profile, write "
        f"{count} distinct, realistic prospective-shopper personas for this store. "
        "For each persona give: a short bold label, a one-line context, their main "
        "motivation, budget sensitivity, what they value most, and their most likely "
        "objection before buying. Keep each to 2-3 sentences.\n\n"
        "Store profile (JSON):\n"
        f"{json.dumps(brief, indent=2)}\n\n"
        "Return a Markdown section that starts with the heading '## Target shoppers'. "
        "These personas simulate how real shoppers react to the store."
    )
    resp = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.9,
            max_output_tokens=2048,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    text = (resp.text or "").strip()
    if not text:
        raise RuntimeError("empty personas response")
    if not text.lower().startswith("## target shoppers"):
        text = "## Target shoppers\n" + text
    return text


def build_audience_section(brief: dict | None, use_llm: bool, count: int | None = None) -> str:
    """Return a '## Target shoppers' markdown section, or '' if no brief."""
    if not brief:
        return ""
    if count is None:
        count = int(os.getenv("MIROFISH_PERSONAS", "6"))

    if use_llm and os.getenv("GEMINI_API_KEY"):
        try:
            return _gemini_section(brief, count)
        except Exception:  # noqa: BLE001 - fall back to the deterministic template
            pass
    return _template_section(brief, count)
