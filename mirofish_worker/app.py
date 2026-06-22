"""FastAPI worker exposing MiroFish simulations as async jobs.

The Remix app calls POST /run, then polls GET /status/:id until completed, then
fetches GET /result/:id. Simulations run in a background thread because the
mirofish CLI is a long-running subprocess.
"""
from __future__ import annotations

import hmac
import json
import os
import threading
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

# Load mirofish_worker/.env before Settings reads its defaults.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

import checkout_sim  # noqa: E402
import runner  # noqa: E402
import swarm  # noqa: E402
import vision_agent  # noqa: E402
from runner import Settings  # noqa: E402
from suggest import suggest_variant  # noqa: E402

app = FastAPI(title="mirofish_worker")
settings = Settings()

# Simulation engine: "swarm" (custom shopper-agent orchestration) or "mirofish"
# (legacy OASIS CLI, kept as an instant rollback). Defaults to swarm.
SHOPSIM_ENGINE = os.getenv("SHOPSIM_ENGINE", "swarm")
_run_experiment = swarm.run_experiment if SHOPSIM_ENGINE == "swarm" else runner.run_experiment

# Shared-secret guard. When BACKEND_SECRET is set, every protected route requires
# a matching `X-ShopSim-Auth` header (the Shopify app sends it). When unset (e.g.
# local dev), the guard is a no-op. /health is always open for healthchecks.
BACKEND_SECRET = os.getenv("BACKEND_SECRET", "")


def require_secret(x_shopsim_auth: str | None = Header(default=None)) -> None:
    if not BACKEND_SECRET:
        return
    if not x_shopsim_auth or not hmac.compare_digest(x_shopsim_auth, BACKEND_SECRET):
        raise HTTPException(status_code=401, detail="unauthorized")


# Applied to every non-public route.
guard = [Depends(require_secret)]

# Thread-safe in-memory job table. Results are also written to disk so they
# survive a worker restart.
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


class RunRequest(BaseModel):
    shopContext: str
    # Variants are required for "ab" mode; unused (and optional) for "full".
    variantA: str = ""
    variantB: str = ""
    requirement: str = ""
    componentType: str = "component"
    audienceBrief: dict | None = None
    # "ab" = score two variants of one component; "full" = whole-store audit.
    mode: str = "ab"


class SuggestRequest(BaseModel):
    componentType: str = "component"
    title: str = ""
    baseline: dict[str, str]


class CheckoutRequest(BaseModel):
    storeUrl: str
    productHandle: str | None = None
    storefrontPassword: str | None = None
    completeOrder: bool = False
    # "scripted" = selector heuristics (checkout_sim); "vision" = computer-use
    # agent driving the browser (vision_agent).
    engine: str = "scripted"
    # For engine="vision": "claude" (default) or "gemini".
    visionProvider: str | None = None


def _result_path(job_id: str) -> Path:
    return settings.runs_dir / job_id / "result.json"


def _set(job_id: str, **fields) -> None:
    with _lock:
        _jobs.setdefault(job_id, {}).update(fields)


def _get(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        if job:
            return dict(job)
    # Fall back to a persisted result after a restart.
    rp = _result_path(job_id)
    if rp.exists():
        try:
            return {"status": "completed", "result": json.loads(rp.read_text("utf-8"))}
        except Exception:
            return None
    return None


def _run_job(job_id: str, payload: dict, fn) -> None:
    """Run a job function, persist its result, and update the job table."""
    try:
        result = fn(job_id, payload, settings)
        rp = _result_path(job_id)
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(json.dumps(result), encoding="utf-8")
        _set(job_id, status="completed", result=result)
    except Exception as err:  # noqa: BLE001 - surface any failure to the client
        _set(job_id, status="failed", error=str(err)[:1000])


def _execute(job_id: str, payload: dict) -> None:
    _run_job(job_id, payload, _run_experiment)


def _execute_checkout(job_id: str, payload: dict) -> None:
    fn = (
        vision_agent.run_vision_checkout
        if payload.get("engine") == "vision"
        else checkout_sim.run_checkout
    )
    _run_job(job_id, payload, fn)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "mock": settings.mock, "provider": settings.provider, "engine": SHOPSIM_ENGINE}


@app.post("/run", dependencies=guard)
def run(req: RunRequest, background: BackgroundTasks) -> dict:
    job_id = uuid.uuid4().hex
    _set(job_id, status="running")
    background.add_task(_execute, job_id, req.model_dump())
    return {"jobId": job_id, "status": "running"}


@app.post("/checkout", dependencies=guard)
def checkout(req: CheckoutRequest, background: BackgroundTasks) -> dict:
    """Start a real browser-driven checkout-friction run (results via /status,/result)."""
    job_id = uuid.uuid4().hex
    _set(job_id, status="running")
    background.add_task(_execute_checkout, job_id, req.model_dump())
    return {"jobId": job_id, "status": "running"}


@app.post("/suggest", dependencies=guard)
def suggest(req: SuggestRequest) -> dict:
    try:
        suggestion = suggest_variant(req.componentType, req.title, req.baseline)
        return {"suggestion": suggestion}
    except Exception as err:  # noqa: BLE001 - return a clean 400 to the frontend
        raise HTTPException(status_code=400, detail=str(err)[:500])


@app.get("/status/{job_id}", dependencies=guard)
def status(job_id: str) -> dict:
    job = _get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="unknown job")
    return {"status": job["status"], "error": job.get("error")}


@app.get("/result/{job_id}", dependencies=guard)
def result(job_id: str) -> dict:
    job = _get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="unknown job")
    if job["status"] != "completed":
        raise HTTPException(status_code=409, detail=f"job is {job['status']}")
    return job["result"]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8800")),
    )
