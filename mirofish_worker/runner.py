"""Drives MiroFish to score two variants of a store component and pick a winner.

Strategy: run `mirofish` once per variant with the *same* shop context and
requirement, parse each run's verdict into a 0..1 score, and compare. This gives
clean attribution since only the component-under-test changes between runs.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from personas import build_audience_section


@dataclass
class Settings:
    mock: bool = os.getenv("MIROFISH_MOCK", "0") in ("1", "true", "True")
    bin: str = os.getenv("MIROFISH_BIN", "mirofish")
    max_rounds: int = int(os.getenv("MIROFISH_MAX_ROUNDS", "6"))
    runs_dir: Path = field(default_factory=lambda: Path(os.getenv("RUNS_DIR", "./runs")))
    provider: str = os.getenv("LLM_PROVIDER", "claude-cli")
    # Single platform reads more like shopper deliberation than parallel, and
    # roughly halves the (dominant) simulation cost. parallel|twitter|reddit.
    platform: str = os.getenv("MIROFISH_PLATFORM", "reddit")
    # Per-variant subprocess timeout in seconds (each A/B test runs this twice).
    timeout: int = int(os.getenv("MIROFISH_TIMEOUT", "1800"))


# Numeric verdict fields we know how to interpret, best first.
SCORE_KEYS = re.compile(
    r"(purchase_intent|conversion|intent|sentiment|score|rating|probability|confidence)",
    re.IGNORECASE,
)


def _normalize(value: float) -> float:
    """Coerce a metric onto 0..1 (handles 0-100 and 0-10 scales)."""
    if value > 1.0 and value <= 10.0:
        return value / 10.0
    if value > 10.0 and value <= 100.0:
        return value / 100.0
    return max(0.0, min(1.0, value))


def _collect_scores(obj: Any, out: list[float]) -> None:
    """Recursively gather numeric values under score-like keys."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (int, float)) and SCORE_KEYS.search(str(k)):
                out.append(_normalize(float(v)))
            else:
                _collect_scores(v, out)
    elif isinstance(obj, list):
        for item in obj:
            _collect_scores(item, out)


def extract_score(verdict: Any, stdout: str | None = None) -> float:
    """Best-effort single 0..1 score from a verdict.json (or stdout JSON)."""
    scores: list[float] = []
    if verdict is not None:
        _collect_scores(verdict, scores)
    if not scores and stdout:
        try:
            _collect_scores(json.loads(stdout), scores)
        except Exception:
            pass
    if not scores:
        return 0.5  # neutral when nothing parseable was found
    return sum(scores) / len(scores)


def _find(root: Path, name: str) -> Path | None:
    for p in root.rglob(name):
        return p
    return None


def _find_svgs(root: Path, limit: int = 6) -> list[Path]:
    return sorted(root.rglob("*.svg"))[:limit]


def _svg_data_uri(path: Path) -> dict[str, str]:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return {"name": path.stem, "dataUri": f"data:image/svg+xml;base64,{b64}"}


def _run_mirofish(
    settings: Settings,
    files: list[Path],
    requirement: str,
    out_dir: Path,
) -> tuple[Any, str]:
    """Invoke the mirofish CLI once; return (verdict_json_or_none, stdout)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # MIROFISH_BIN may be a single executable path or a full command such as
    # "uv --directory /path/to/mirofish-cli run mirofish".
    bin_parts = shlex.split(settings.bin, posix=(os.name != "nt"))
    cmd = [
        *bin_parts,
        "run",
        "--files",
        *[str(f) for f in files],
        "--requirement",
        requirement,
        "--max-rounds",
        str(settings.max_rounds),
        "--platform",
        settings.platform,
        "--output-dir",
        str(out_dir),
        "--json",
    ]
    # Capture stdout (the --json machine output) but let stderr stream straight to
    # the worker's stderr -> Railway logs, so MiroFish/OASIS progress is visible
    # live (where it's at: ontology, graph, simulation rounds, etc.).
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            timeout=settings.timeout,
            env={**os.environ, "LLM_PROVIDER": settings.provider},
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"MiroFish timed out after {settings.timeout}s. Lower MIROFISH_MAX_ROUNDS "
            f"and/or MIROFISH_PERSONAS, or raise MIROFISH_TIMEOUT. See backend logs for "
            f"the stage it was stuck on."
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"mirofish exited {proc.returncode} (see backend logs): {(proc.stdout or '')[-500:]}"
        )
    verdict_path = _find(out_dir, "verdict.json")
    verdict = None
    if verdict_path:
        try:
            verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
        except Exception:
            verdict = None
    return verdict, proc.stdout


def _requirement(component_type: str, base: str) -> str:
    return (
        f"{base}\n\n"
        "Simulate this store's realistic prospective shoppers (the 'Target shoppers' "
        "described in the first file) making a buying decision about the "
        f"{component_type.replace('_', ' ')} variant in the second file. Each shopper weighs "
        "price vs. perceived value, trust and credibility, relevance to their needs, and voices "
        "objections or excitement the way a real customer would before purchasing. Predict the "
        "share of these shoppers who would buy. End the verdict with an explicit numeric "
        "'purchase_intent' score from 0 to 100 and a 'confidence' from 0 to 1."
    )


def _mock_run(text: str) -> float:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return int(h[:4], 16) / 0xFFFF


def run_experiment(job_id: str, payload: dict, settings: Settings | None = None) -> dict:
    settings = settings or Settings()
    run_root = settings.runs_dir / job_id
    run_root.mkdir(parents=True, exist_ok=True)

    component_type = payload.get("componentType", "component")
    requirement = _requirement(component_type, payload.get("requirement", ""))

    # Seed shopper personas (once, shared by both variant runs). Gemini-generated
    # for real runs; deterministic template in mock so mock stays free.
    audience = build_audience_section(
        payload.get("audienceBrief"), use_llm=not settings.mock
    )
    shop_context = (
        f"{audience}\n\n{payload['shopContext']}" if audience else payload["shopContext"]
    )

    ctx = run_root / "shop_context.md"
    var_a = run_root / "variant_a.md"
    var_b = run_root / "variant_b.md"
    ctx.write_text(shop_context, encoding="utf-8")
    var_a.write_text(payload["variantA"], encoding="utf-8")
    var_b.write_text(payload["variantB"], encoding="utf-8")

    if settings.mock:
        time.sleep(1.0)
        score_a = _mock_run(payload["variantA"])
        score_b = _mock_run(payload["variantB"] + "b")
        report = (
            f"# MiroFish (mock) verdict\n\n"
            f"Simulated shopper swarm reacting to the **{component_type}**.\n\n"
            f"- Variant A purchase intent: **{score_a*100:.0f}**\n"
            f"- Variant B purchase intent: **{score_b*100:.0f}**\n\n"
            f"_This is a deterministic mock; set MIROFISH_MOCK=0 for a real run._"
        )
        svgs = [{"name": "mock", "dataUri": _mock_svg(score_a, score_b)}]
    else:
        verdict_a, out_a = _run_mirofish(settings, [ctx, var_a], requirement, run_root / "a")
        verdict_b, out_b = _run_mirofish(settings, [ctx, var_b], requirement, run_root / "b")
        score_a = extract_score(verdict_a, out_a)
        score_b = extract_score(verdict_b, out_b)
        winner_dir = run_root / ("a" if score_a >= score_b else "b")
        report_path = _find(winner_dir, "report.md")
        report = report_path.read_text(encoding="utf-8") if report_path else ""
        svgs = [_svg_data_uri(p) for p in _find_svgs(winner_dir)]

    winner = "A" if score_a >= score_b else "B"
    confidence = min(0.99, 0.5 + abs(score_a - score_b) / 2)

    return {
        "winner": winner,
        "confidence": round(confidence, 3),
        "scoreA": round(score_a, 3),
        "scoreB": round(score_b, 3),
        "reportMarkdown": report,
        "svgs": svgs,
    }


def _mock_svg(a: float, b: float) -> str:
    ha, hb = int(a * 160), int(b * 160)
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'>
<rect width='320' height='200' fill='#f6f6f7'/>
<rect x='60' y='{180-ha}' width='80' height='{ha}' fill='#5c6ac4'/>
<rect x='180' y='{180-hb}' width='80' height='{hb}' fill='#47c1bf'/>
<text x='100' y='195' font-size='12' text-anchor='middle'>Variant A</text>
<text x='220' y='195' font-size='12' text-anchor='middle'>Variant B</text>
</svg>"""
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
