"""Custom shopper-agent swarm — the replacement for the MiroFish/OASIS engine.

Two modes, selected by `payload["mode"]`:

  * "ab"   — score two variants of ONE component. A small cohort of agents
             (AB_AGENT_COUNT) each evaluates variant A and B *paired*, and we
             return the existing {winner, confidence, scoreA, scoreB,
             reportMarkdown, svgs} verdict.

  * "full" — audit the WHOLE store. A heavy "boss" grasps the store and splits
             its buyers into weighted segments; each product gets a cohort of
             AGENTS_PER_PRODUCT cheap agents (total capped at MAX_EASY_AGENT)
             that decide buy/no-buy and leave a review. Returns an audit shape
             {mode:"full", storeScore, summaryMarkdown, products[], reviews[],
             svgs[]}.

`run_experiment(job_id, payload, settings)` matches `runner.run_experiment`'s
signature, so `app.py`'s job/queue/persistence layer is reused untouched.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from collections import Counter
from typing import Any

import gemini
from runner import Settings

# ---------------------------------------------------------------------------
# Store-context parsing helpers
# ---------------------------------------------------------------------------

_PRODUCT_HEADING = re.compile(r"^##\s+Product:\s*(.+?)\s*$", re.MULTILINE)


def _split_products(shop_context: str) -> list[tuple[str, str]]:
    """Extract (title, markdown_block) for each '## Product:' section."""
    out: list[tuple[str, str]] = []
    matches = list(_PRODUCT_HEADING.finditer(shop_context))
    for i, m in enumerate(matches):
        start = m.start()
        # Block runs until the next product heading, or any '# '/'## ' header.
        end = matches[i + 1].start() if i + 1 < len(matches) else len(shop_context)
        block = shop_context[start:end].strip()
        # Trim a trailing top-level section header that bled into the block.
        block = re.split(r"\n#\s", block, maxsplit=1)[0].strip()
        out.append((m.group(1).strip(), block))
    return out


def _store_summary(brief: dict | None, profile: dict | None) -> str:
    """A short grounding blurb for easy-agent prompts (keeps tokens down)."""
    brief = brief or {}
    profile = profile or {}
    brand = brief.get("brandName") or "this store"
    store_type = profile.get("storeType") or ", ".join(brief.get("categories") or []) or "online store"
    sentiment = profile.get("marketSentiment") or ""
    line = f"{brand} — a {store_type}."
    if sentiment:
        line += f" Market: {sentiment}"
    return line


def _truncate(text: str, limit: int = 20000) -> str:
    return text if len(text) <= limit else text[:limit] + "\n…[truncated]"


def _intent(v: Any) -> float:
    """Coerce a model 'purchase_intent' onto 0..100."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 50.0
    if 0 <= x <= 1:  # tolerate a 0..1 answer
        x *= 100
    return max(0.0, min(100.0, x))


def _allocate_segments(segments: list[dict], n: int) -> list[dict | None]:
    """Assign each of n agents a buyer segment, weighted by 'share'."""
    if not segments:
        return [None] * n
    shares = [max(0.0, float(s.get("share", 0) or 0)) for s in segments]
    total = sum(shares) or float(len(segments))
    if sum(shares) == 0:  # equal weight when shares are missing
        shares = [1.0] * len(segments)
    raw = [sh / total * n for sh in shares]
    counts = [int(x) for x in raw]
    order = sorted(range(len(segments)), key=lambda i: raw[i] - counts[i], reverse=True)
    for i in range(n - sum(counts)):
        counts[order[i % len(segments)]] += 1
    out: list[dict | None] = []
    for seg, c in zip(segments, counts):
        out.extend([seg] * c)
    while len(out) < n:
        out.append(segments[0])
    return out[:n]


def _segment_line(seg: dict | None) -> str:
    if not seg:
        return "a typical prospective shopper"
    return (
        f"{seg.get('name', 'shopper')} — motivation: {seg.get('motivations', 'value')}; "
        f"price sensitivity: {seg.get('priceSensitivity', 'medium')}; "
        f"likely objection: {seg.get('objections', 'unsure')}"
    )


# ---------------------------------------------------------------------------
# SVG builders (no LLM)
# ---------------------------------------------------------------------------


def _data_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def _ab_bars_svg(score_a: float, score_b: float) -> dict[str, str]:
    ha, hb = int(score_a * 160), int(score_b * 160)
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'>"
        "<rect width='320' height='200' fill='#f6f6f7'/>"
        f"<rect x='60' y='{180 - ha}' width='80' height='{ha}' fill='#5c6ac4'/>"
        f"<rect x='180' y='{180 - hb}' width='80' height='{hb}' fill='#47c1bf'/>"
        "<text x='100' y='195' font-size='12' text-anchor='middle'>Variant A</text>"
        "<text x='220' y='195' font-size='12' text-anchor='middle'>Variant B</text>"
        "</svg>"
    )
    return {"name": "purchase_intent", "dataUri": _data_uri(svg)}


def _gauge_svg(store_score: float) -> dict[str, str]:
    w = int(max(0.0, min(100.0, store_score)) / 100 * 280)
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='90'>"
        "<rect width='320' height='90' fill='#f6f6f7'/>"
        "<rect x='20' y='35' width='280' height='20' rx='10' fill='#e3e3e3'/>"
        f"<rect x='20' y='35' width='{w}' height='20' rx='10' fill='#008060'/>"
        f"<text x='160' y='25' font-size='13' text-anchor='middle'>Store score: {store_score:.0f}/100</text>"
        "</svg>"
    )
    return {"name": "store_score", "dataUri": _data_uri(svg)}


def _product_bars_svg(products: list[dict]) -> dict[str, str]:
    items = products[:8]
    width = max(320, 40 + len(items) * 60)
    bars = []
    for i, p in enumerate(items):
        h = int(p["score"] / 100 * 150)
        x = 40 + i * 60
        label = (p["title"][:8] + "…") if len(p["title"]) > 9 else p["title"]
        bars.append(f"<rect x='{x}' y='{170 - h}' width='40' height='{h}' fill='#5c6ac4'/>")
        bars.append(
            f"<text x='{x + 20}' y='185' font-size='9' text-anchor='middle'>{label}</text>"
        )
    svg = (
        f"<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='200'>"
        f"<rect width='{width}' height='200' fill='#f6f6f7'/>" + "".join(bars) + "</svg>"
    )
    return {"name": "per_product_intent", "dataUri": _data_uri(svg)}


# ---------------------------------------------------------------------------
# Boss + summarize (heavy model, single calls)
# ---------------------------------------------------------------------------


def _boss_prompt(shop_context: str, brief: dict | None, mode: str) -> str:
    products_clause = (
        '\n  "products": [{"title": "<EXACT product title from the context>", '
        '"summary": "<one line>"}]  // ranked, most commercially important first'
        if mode == "full"
        else ""
    )
    return (
        "You are a senior e-commerce strategist. Study this store and its audience, "
        "then describe who really buys here and how they decide.\n\n"
        f"STORE CONTEXT:\n{_truncate(shop_context)}\n\n"
        f"AUDIENCE BRIEF (JSON):\n{json.dumps(brief or {}, indent=2)}\n\n"
        "Return ONLY a JSON object:\n"
        "{\n"
        '  "storeType": "<short phrase>",\n'
        '  "marketSentiment": "<1 sentence on how this market\'s buyers feel and decide>",\n'
        '  "buyerSegments": [{"name": "...", "share": <0-100>, "motivations": "...", '
        '"priceSensitivity": "low|medium|high", "objections": "..."}]  // 4-6 segments, shares ~sum 100'
        f"{products_clause}\n"
        "}"
    )


def _summarize_prompt(mode: str, payload_brief: dict | None, data: dict) -> str:
    if mode == "ab":
        intro = (
            "Synthetic shoppers compared two variants of a "
            f"{data.get('componentType', 'component')}. Write a concise verdict for the merchant: "
            "which variant won and why, the strongest objections, and 1-2 representative quotes."
        )
    else:
        intro = (
            "Synthetic shoppers ran a full-store experience test. Write a concise audit for the "
            "merchant: overall verdict, what wins shoppers, what loses them (top objections), "
            "weakest products, and concrete fixes."
        )
    return (
        f"{intro}\n\nDATA (JSON):\n{json.dumps(data, indent=2)[:12000]}\n\n"
        'Return ONLY JSON: {"markdown": "<the report in GitHub-flavored Markdown>"}'
    )


# ---------------------------------------------------------------------------
# Easy-agent prompts (cheap model, parallel)
# ---------------------------------------------------------------------------


def _ab_agent_prompt(
    summary: str, seg: dict | None, component_type: str, variant_a: str, variant_b: str, extra: str
) -> str:
    return (
        f"Role-play ONE realistic shopper for {summary}\n"
        f"Your shopper segment: {_segment_line(seg)}.\n"
        f"Adopt a concrete persona in that segment. {extra}\n\n"
        f"You are shown two versions (A and B) of the same {component_type.replace('_', ' ')}. "
        "React to each as a buying decision, then say which you prefer.\n\n"
        f"VERSION A:\n{variant_a}\n\nVERSION B:\n{variant_b}\n\n"
        "Return ONLY JSON:\n"
        '{"a": {"would_buy": true, "purchase_intent": 0-100, "objection": "<short>", "review": "<1-2 sentences, first person>"},\n'
        ' "b": {"would_buy": true, "purchase_intent": 0-100, "objection": "<short>", "review": "<1-2 sentences, first person>"},\n'
        ' "prefers": "A"|"B"|"neither"}'
    )


def _full_agent_prompt(summary: str, seg: dict | None, product_block: str, extra: str) -> str:
    return (
        f"Role-play ONE realistic shopper for {summary}\n"
        f"Your shopper segment: {_segment_line(seg)}.\n"
        f"Adopt a concrete persona in that segment and react to this product as if shopping the store. {extra}\n\n"
        f"PRODUCT:\n{product_block}\n\n"
        "Decide whether you would buy it. Return ONLY JSON:\n"
        '{"persona": "<2-4 word label>", "would_buy": true, "purchase_intent": 0-100, '
        '"objection": "<main hesitation, short>", "review": "<1-2 sentence first-person reaction>"}'
    )


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _confidence_from_prefs(a_count: int, b_count: int, score_a: float, score_b: float) -> float:
    """Laplace-smoothed winner-preference share; shrinks small samples to 0.5."""
    pref_total = a_count + b_count
    if pref_total == 0:
        return min(0.99, 0.5 + abs(score_a - score_b) / 2)
    winner_count = max(a_count, b_count)
    conf = (winner_count + 1) / (pref_total + 2)  # Bayesian posterior mean
    return round(max(0.5, min(0.99, conf)), 3)


def _top_objections(objs: list[str], k: int = 3) -> list[str]:
    cleaned = [o.strip() for o in objs if isinstance(o, str) and o.strip()]
    return [o for o, _ in Counter(cleaned).most_common(k)]


# ---------------------------------------------------------------------------
# Orchestration (async)
# ---------------------------------------------------------------------------


async def _orchestrate(payload: dict, settings: Settings) -> dict:
    mode = payload.get("mode", "ab")
    brief = payload.get("audienceBrief")
    shop_context = payload.get("shopContext", "")
    extra = (payload.get("requirement") or "").strip()

    profile = await asyncio.to_thread(
        gemini.chat_json,
        _boss_prompt(shop_context, brief, mode),
        model=settings.boss_model,
        temperature=0.7,
        max_output_tokens=2048,
    )
    summary = _store_summary(brief, profile)
    segments = profile.get("buyerSegments") or []

    if mode == "full":
        return await _full(payload, settings, profile, summary, segments, shop_context)
    return await _ab(payload, settings, profile, summary, segments, extra)


async def _ab(payload, settings, profile, summary, segments, extra) -> dict:
    n = max(1, min(settings.ab_agent_count, settings.max_easy_agent))
    component_type = payload.get("componentType", "component")
    variant_a = payload.get("variantA") or ""
    variant_b = payload.get("variantB") or ""
    seg_assign = _allocate_segments(segments, n)

    prompts = [
        _ab_agent_prompt(summary, seg, component_type, variant_a, variant_b, extra)
        for seg in seg_assign
    ]
    neutral = {"a": {"purchase_intent": 50}, "b": {"purchase_intent": 50}, "prefers": "neither"}
    results = await gemini.gather_json(
        prompts,
        model=settings.easy_model,
        concurrency=settings.easy_concurrency,
        temperature=0.9,
        max_output_tokens=700,
        on_error=lambda i, e: dict(neutral),
    )

    intents_a, intents_b = [], []
    a_pref = b_pref = 0
    reviews: list[dict] = []
    objs_a, objs_b = [], []
    for r in results:
        a, b = r.get("a") or {}, r.get("b") or {}
        intents_a.append(_intent(a.get("purchase_intent")))
        intents_b.append(_intent(b.get("purchase_intent")))
        pref = str(r.get("prefers", "")).upper()
        if pref == "A":
            a_pref += 1
        elif pref == "B":
            b_pref += 1
        if a.get("objection"):
            objs_a.append(str(a["objection"]))
        if b.get("objection"):
            objs_b.append(str(b["objection"]))
        for side, rec in (("A", a), ("B", b)):
            if rec.get("review"):
                reviews.append({"variant": side, "text": str(rec["review"])})

    score_a = (sum(intents_a) / len(intents_a)) / 100 if intents_a else 0.5
    score_b = (sum(intents_b) / len(intents_b)) / 100 if intents_b else 0.5
    winner = "A" if score_a >= score_b else "B"
    confidence = _confidence_from_prefs(a_pref, b_pref, score_a, score_b)

    report_data = {
        "componentType": component_type,
        "winner": winner,
        "scoreA": round(score_a, 3),
        "scoreB": round(score_b, 3),
        "preferenceCounts": {"A": a_pref, "B": b_pref, "neither": len(results) - a_pref - b_pref},
        "topObjectionsA": _top_objections(objs_a),
        "topObjectionsB": _top_objections(objs_b),
        "sampleReviews": reviews[:8],
    }
    summary_out = await asyncio.to_thread(
        gemini.chat_json,
        _summarize_prompt("ab", payload.get("audienceBrief"), report_data),
        model=settings.boss_model,
        temperature=0.6,
        max_output_tokens=1500,
    )
    return {
        "winner": winner,
        "confidence": confidence,
        "scoreA": round(score_a, 3),
        "scoreB": round(score_b, 3),
        "reportMarkdown": summary_out.get("markdown", ""),
        "svgs": [_ab_bars_svg(score_a, score_b)],
    }


async def _full(payload, settings, profile, summary, segments, shop_context) -> dict:
    # Prefer the boss-ranked product list; fall back to parsing the context.
    blocks = dict(_split_products(shop_context))
    ranked = profile.get("products") or [{"title": t} for t in blocks]
    per = max(1, settings.agents_per_product)
    max_products = max(1, settings.max_easy_agent // per)

    selected: list[tuple[str, str]] = []
    for p in ranked:
        title = (p.get("title") or "").strip()
        block = blocks.get(title)
        if block is None:  # boss title not found verbatim — synthesize a stub
            block = f"## Product: {title}\n{p.get('summary', '')}".strip()
        if title:
            selected.append((title, block))
        if len(selected) >= max_products:
            break
    if not selected:  # no products at all — degrade gracefully
        selected = [("the store", _truncate(shop_context, 4000))]

    # Build the flat prompt list (per-product cohort of `per` agents).
    prompts: list[str] = []
    owner: list[int] = []  # prompt index -> product index
    for pi, (_title, block) in enumerate(selected):
        for seg in _allocate_segments(segments, per):
            prompts.append(_full_agent_prompt(summary, seg, block, ""))
            owner.append(pi)

    neutral = {"persona": "(no response)", "purchase_intent": 50, "objection": "", "review": ""}
    results = await gemini.gather_json(
        prompts,
        model=settings.easy_model,
        concurrency=settings.easy_concurrency,
        temperature=0.95,
        max_output_tokens=500,
        on_error=lambda i, e: dict(neutral),
    )

    # Aggregate per product.
    by_product: list[dict] = [
        {"title": t, "intents": [], "objections": [], "reviews": []} for t, _ in selected
    ]
    all_reviews: list[dict] = []
    for r, pi in zip(results, owner):
        bucket = by_product[pi]
        bucket["intents"].append(_intent(r.get("purchase_intent")))
        if r.get("objection"):
            bucket["objections"].append(str(r["objection"]))
        review = str(r.get("review") or "").strip()
        if review:
            rating = _intent(r.get("purchase_intent"))
            bucket["reviews"].append({"text": review, "rating": rating})
            all_reviews.append(
                {"persona": str(r.get("persona") or "shopper"), "rating": round(rating), "text": review}
            )

    products_out: list[dict] = []
    for b in by_product:
        score = sum(b["intents"]) / len(b["intents"]) if b["intents"] else 50.0
        highlight = ""
        if b["reviews"]:
            highlight = max(b["reviews"], key=lambda x: x["rating"])["text"]
        products_out.append(
            {
                "title": b["title"],
                "score": round(score, 1),
                "topObjections": _top_objections(b["objections"]),
                "highlight": highlight,
            }
        )

    store_score = (
        sum(p["score"] for p in products_out) / len(products_out) if products_out else 50.0
    )
    # Keep a representative, varied review sample (highest-rated first).
    all_reviews.sort(key=lambda x: x["rating"], reverse=True)
    reviews_sample = all_reviews[:12]

    summary_data = {
        "storeScore": round(store_score, 1),
        "products": products_out,
        "reviews": reviews_sample,
        "storeType": profile.get("storeType"),
        "marketSentiment": profile.get("marketSentiment"),
    }
    summary_out = await asyncio.to_thread(
        gemini.chat_json,
        _summarize_prompt("full", payload.get("audienceBrief"), summary_data),
        model=settings.boss_model,
        temperature=0.6,
        max_output_tokens=2000,
    )

    return {
        "mode": "full",
        "storeScore": round(store_score, 1),
        "summaryMarkdown": summary_out.get("markdown", ""),
        "products": products_out,
        "reviews": reviews_sample,
        "svgs": [_gauge_svg(store_score), _product_bars_svg(products_out)],
    }


# ---------------------------------------------------------------------------
# Mock mode (deterministic, no LLM)
# ---------------------------------------------------------------------------


def _hash01(text: str) -> float:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:4], 16) / 0xFFFF


def _mock(payload: dict) -> dict:
    mode = payload.get("mode", "ab")
    if mode == "full":
        products = _split_products(payload.get("shopContext", "")) or [("Sample product", "")]
        products_out = []
        for title, _ in products[:10]:
            score = round(_hash01(title) * 100, 1)
            products_out.append(
                {
                    "title": title,
                    "score": score,
                    "topObjections": ["price", "shipping time"],
                    "highlight": f"As a shopper I found {title} appealing but hesitated on price.",
                }
            )
        store_score = round(sum(p["score"] for p in products_out) / len(products_out), 1)
        reviews = [
            {"persona": "Bargain hunter", "rating": int(p["score"]), "text": p["highlight"]}
            for p in products_out[:5]
        ]
        return {
            "mode": "full",
            "storeScore": store_score,
            "summaryMarkdown": (
                f"# Full-store customer test (mock)\n\nOverall store score: **{store_score}/100** "
                f"across {len(products_out)} products.\n\n"
                "_Deterministic mock; set MIROFISH_MOCK=0 for a real swarm run._"
            ),
            "products": products_out,
            "reviews": reviews,
            "svgs": [_gauge_svg(store_score), _product_bars_svg(products_out)],
        }

    score_a = _hash01(payload.get("variantA", ""))
    score_b = _hash01(payload.get("variantB", "") + "b")
    winner = "A" if score_a >= score_b else "B"
    return {
        "winner": winner,
        "confidence": round(min(0.99, 0.5 + abs(score_a - score_b) / 2), 3),
        "scoreA": round(score_a, 3),
        "scoreB": round(score_b, 3),
        "reportMarkdown": (
            f"# Swarm A/B verdict (mock)\n\n"
            f"- Variant A purchase intent: **{score_a * 100:.0f}**\n"
            f"- Variant B purchase intent: **{score_b * 100:.0f}**\n\n"
            "_Deterministic mock; set MIROFISH_MOCK=0 for a real swarm run._"
        ),
        "svgs": [_ab_bars_svg(score_a, score_b)],
    }


# ---------------------------------------------------------------------------
# Entry point (matches runner.run_experiment signature)
# ---------------------------------------------------------------------------


def run_experiment(job_id: str, payload: dict, settings: Settings | None = None) -> dict:
    settings = settings or Settings()
    if settings.mock:
        return _mock(payload)
    return asyncio.run(
        gemini.run_with_timeout(_orchestrate(payload, settings), settings.swarm_timeout)
    )
