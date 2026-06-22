"""Vision-driven checkout agent — computer-use driving a real browser.

Unlike `checkout_sim.py` (scripted selectors + heuristics), this lets a model
*see* the store and decide what to do: it gets a screenshot of the browser
viewport, returns a computer-use action (click at [x,y], type, scroll, …), we
execute it with Playwright, screenshot again, and loop. The model narrates the
UX friction it notices as a first-time shopper.

Two providers, selected by the VISION_PROVIDER env var ("claude" default | "gemini"):
  * Claude — `computer_20251124` tool, beta `computer-use-2025-11-24`,
    `claude-opus-4-8`, pixel coordinates (`_run_claude`).
  * Gemini — `ComputerUse(ENVIRONMENT_BROWSER)` tool,
    `gemini-2.5-computer-use-preview-10-2025`, function-calls with 0-1000
    normalized coordinates (`_run_gemini`).

Goal is "navigate & audit": shop → product → cart → checkout, STOP before
payment. It never enters payment details, places an order, or logs in.

Playwright is the "computer": no Xvfb/desktop needed — the same `BrowserComputer`
executes both providers' actions on `page.mouse` / `page.keyboard`. The viewport
is sized within the models' image limits.
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any
from urllib.parse import urlparse

from runner import Settings

_BETA = "computer-use-2025-11-24"
_TOOL_TYPE = "computer_20251124"

_SYSTEM = (
    "You are a UX researcher evaluating an online store's checkout flow as a "
    "first-time shopper on a desktop browser. Your goal: starting from the "
    "storefront, find a product, add it to the cart, and proceed through checkout "
    "AS FAR AS the payment step — then STOP.\n\n"
    "HARD RULES (never break these):\n"
    "- Do NOT enter any payment card details.\n"
    "- Do NOT place or confirm an order.\n"
    "- Do NOT log in or create an account with real credentials.\n"
    "- Stop as soon as you reach the payment/credit-card step.\n\n"
    "Work in small steps. After each action take a screenshot and check the result. "
    "Pages can take a moment to load: after an action, wait briefly and take a FRESH "
    "screenshot before drawing any conclusion. If a page looks blank, half-loaded, or "
    "like nothing happened, take another screenshot (or use the wait action) before "
    "deciding — do not assume an action failed or the store is broken just because the "
    "first screenshot looks empty.\n"
    "As you go, narrate the friction a real shopper would hit: slow or broken steps, "
    "confusing layout, hard-to-find buttons, unexpected or excessive steps, forced "
    "account creation, missing trust signals, unclear shipping cost or returns. "
    "When you reach the payment step or cannot proceed, write a final summary of the "
    "friction points you found, ordered by severity (high/medium/low)."
)


def _normalize_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("storeUrl is required (e.g. your-store.myshopify.com)")
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    return raw.rstrip("/")


def _origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


# ---------------------------------------------------------------------------
# Playwright "computer": maps Claude's actions onto a real browser page
# ---------------------------------------------------------------------------


class BrowserComputer:
    """Executes computer-use actions against a Playwright page."""

    def __init__(self, page, width: int, height: int, settle_ms: int, settle_timeout_ms: int):
        self.page = page
        self.width = width
        self.height = height
        self.settle_ms = settle_ms
        self.settle_timeout_ms = settle_timeout_ms

    def _wait_idle(self) -> None:
        try:
            self.page.wait_for_load_state("networkidle", timeout=self.settle_timeout_ms)
        except Exception:  # noqa: BLE001 - long-poll/analytics pages never go idle
            pass

    def settle(self) -> None:
        """After a state-changing action, let the page finish loading so the
        NEXT screenshot reflects the loaded page, not a mid-load flash."""
        self._wait_idle()
        if self.settle_ms:
            try:
                self.page.wait_for_timeout(self.settle_ms)
            except Exception:  # noqa: BLE001
                pass

    def screenshot_b64(self) -> str:
        raw = self.page.screenshot(type="png")
        return base64.b64encode(raw).decode("ascii")

    def _key(self, combo: str) -> str:
        # "ctrl+s" -> "Control+s"; map common modifiers to Playwright names.
        parts = combo.replace(" ", "").split("+")
        mods = {"ctrl": "Control", "control": "Control", "alt": "Alt",
                "shift": "Shift", "super": "Meta", "cmd": "Meta", "win": "Meta"}
        return "+".join(mods.get(p.lower(), p) for p in parts)

    def run(self, action: str, params: dict) -> dict | str:
        """Return an image dict for screenshots, else a short text status."""
        coord = params.get("coordinate") or [0, 0]
        x, y = int(coord[0]), int(coord[1])
        text = params.get("text")
        if action == "screenshot":
            # Make sure the page has loaded before we capture it.
            self._wait_idle()
            return {"image": self.screenshot_b64()}
        if action == "left_click":
            self._click(x, y, text, button="left")
            self.settle()
            return f"clicked ({x}, {y})"
        if action in ("right_click", "middle_click"):
            self._click(x, y, text, button=action.split("_")[0])
            self.settle()
            return f"{action} ({x}, {y})"
        if action == "double_click":
            self.page.mouse.dblclick(x, y)
            self.settle()
            return f"double-clicked ({x}, {y})"
        if action == "mouse_move":
            self.page.mouse.move(x, y)
            return f"moved to ({x}, {y})"
        if action == "type":
            self.page.keyboard.type(text or "")
            return f"typed {len(text or '')} chars"
        if action == "key":
            self.page.keyboard.press(self._key(text or ""))
            self.settle()  # Enter/submit often navigates
            return f"pressed {text}"
        if action == "scroll":
            self.page.mouse.move(x, y)
            amount = int(params.get("scroll_amount", 3)) * 100
            direction = params.get("scroll_direction", "down")
            dx, dy = 0, 0
            if direction == "down":
                dy = amount
            elif direction == "up":
                dy = -amount
            elif direction == "right":
                dx = amount
            elif direction == "left":
                dx = -amount
            self.page.mouse.wheel(dx, dy)
            self.settle()  # lazy-loaded content / infinite scroll
            return f"scrolled {direction}"
        if action == "wait":
            self.page.wait_for_timeout(int(float(params.get("duration", 1)) * 1000))
            return "waited"
        if action == "left_click_drag":
            sx, sy = (params.get("start_coordinate") or [x, y])
            self.page.mouse.move(int(sx), int(sy))
            self.page.mouse.down()
            self.page.mouse.move(x, y)
            self.page.mouse.up()
            self.settle()
            return "dragged"
        return f"unsupported action: {action}"

    def _click(self, x: int, y: int, modifier: str | None, button: str) -> None:
        if modifier:
            key = self._key(modifier)
            self.page.keyboard.down(key)
            self.page.mouse.click(x, y, button=button)
            self.page.keyboard.up(key)
        else:
            self.page.mouse.click(x, y, button=button)


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


def _tool_result_blocks(response, computer: BrowserComputer, settings: Settings,
                        shots: list[dict]) -> list[dict]:
    """Execute each tool_use block; return tool_result blocks for the next turn."""
    results: list[dict] = []
    for block in response.content:
        if getattr(block, "type", None) != "tool_use":
            continue
        params = block.input or {}
        action = params.get("action", "")
        try:
            out = computer.run(action, params)
        except Exception as err:  # noqa: BLE001 - surface as a tool error, keep going
            results.append({
                "type": "tool_result", "tool_use_id": block.id,
                "content": f"Error running {action}: {str(err)[:160]}", "is_error": True,
            })
            continue
        if isinstance(out, dict) and "image" in out:
            if settings.checkout_screenshots and len(shots) < 12:
                shots.append({"name": f"step{len(shots)+1}",
                              "dataUri": "data:image/png;base64," + out["image"]})
            results.append({
                "type": "tool_result", "tool_use_id": block.id,
                "content": [{"type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": out["image"]}}],
            })
        else:
            results.append({
                "type": "tool_result", "tool_use_id": block.id, "content": str(out)})
    return results


def _collect_text(response) -> str:
    return "\n".join(
        b.text for b in response.content if getattr(b, "type", None) == "text" and b.text
    ).strip()


def _findings_prompt(narration: str) -> str:
    return (
        "A vision agent shopped a store's checkout and narrated the UX friction it hit. "
        "From the narration, produce JSON only:\n"
        '{"score": <0-100 smoothness, higher=smoother>, "reachedStep": "<storefront|product|cart|checkout|payment>", '
        '"frictions": [{"step": "...", "severity": "low|medium|high", "issue": "..."}], '
        '"summaryMarkdown": "<concise merchant report in GitHub-flavored Markdown>"}\n\n'
        f"NARRATION:\n{narration[:12000]}"
    )


def _findings_fallback(narration: str) -> dict:
    return {"score": 50, "reachedStep": "checkout", "frictions": [],
            "summaryMarkdown": narration or "_No findings returned._"}


def _extract_findings_claude(client, model: str, narration: str) -> dict:
    """Turn the agent's free-text narration into a structured friction report."""
    try:
        msg = client.messages.create(
            model=model, max_tokens=1500,
            messages=[{"role": "user", "content": _findings_prompt(narration)}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        start, end = text.find("{"), text.rfind("}")
        return json.loads(text[start:end + 1])
    except Exception:  # noqa: BLE001 - fall back to narration-only
        return _findings_fallback(narration)


def _extract_findings_gemini(model: str, narration: str) -> dict:
    """Same, via the shared Gemini JSON helper (no Anthropic client needed)."""
    import gemini

    try:
        return gemini.chat_json(_findings_prompt(narration), model=model,
                                temperature=0.4, max_output_tokens=1500)
    except Exception:  # noqa: BLE001
        return _findings_fallback(narration)


def _result(store_url: str, findings: dict, shots: list[dict]) -> dict:
    return {
        "mode": "checkout",
        "engine": "vision",
        "storeUrl": store_url,
        "score": int(findings.get("score", 50)),
        "reachedStep": findings.get("reachedStep", "checkout"),
        "steps": [],
        "frictions": findings.get("frictions", []),
        "blockers": [],
        "summaryMarkdown": findings.get("summaryMarkdown", ""),
        "screenshots": shots,
    }


def _run_claude(payload: dict, settings: Settings) -> dict:
    import anthropic
    from playwright.sync_api import sync_playwright

    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set on the backend. Set it to run the vision "
            "agent, or use MIROFISH_MOCK=1 for a deterministic LLM-free run."
        )

    store_url = _normalize_url(payload.get("storeUrl", ""))
    w, h = settings.vision_viewport_w, settings.vision_viewport_h
    client = anthropic.Anthropic()
    shots: list[dict] = []
    narration_parts: list[str] = []
    deadline = time.monotonic() + settings.checkout_timeout

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=settings.checkout_headless)
        context = browser.new_context(viewport={"width": w, "height": h})
        context.set_default_timeout(settings.checkout_nav_timeout)
        page = context.new_page()
        computer = BrowserComputer(
            page, w, h, settings.checkout_settle_ms, settings.checkout_settle_timeout_ms
        )
        try:
            page.goto(store_url, wait_until="domcontentloaded",
                      timeout=settings.checkout_nav_timeout)
            computer.settle()  # let the storefront finish before the first screenshot
        except Exception as err:  # noqa: BLE001
            narration_parts.append(f"Could not open the storefront: {str(err)[:160]}")

        tools = [{"type": _TOOL_TYPE, "name": "computer",
                  "display_width_px": w, "display_height_px": h, "display_number": 1}]
        messages: list[dict] = [{
            "role": "user",
            "content": [
                {"type": "text", "text":
                    f"The store is open at {store_url}. Begin shopping and stop at the "
                    "payment step. Take a screenshot first to see the page."},
            ],
        }]

        try:
            for _ in range(settings.vision_max_steps):
                if time.monotonic() > deadline:
                    narration_parts.append("(stopped: time budget reached)")
                    break
                resp = client.beta.messages.create(
                    model=settings.vision_model, max_tokens=4096, system=_SYSTEM,
                    tools=tools, messages=messages, betas=[_BETA],
                )
                text = _collect_text(resp)
                if text:
                    narration_parts.append(text)
                messages.append({"role": "assistant", "content": resp.content})
                tool_results = _tool_result_blocks(resp, computer, settings, shots)
                if not tool_results:  # no tool use -> agent is done
                    break
                messages.append({"role": "user", "content": tool_results})
        except Exception as err:  # noqa: BLE001 - record, still report what we have
            narration_parts.append(f"(run aborted: {str(err)[:200]})")
        finally:
            context.close()
            browser.close()

    narration = "\n\n".join(narration_parts)
    findings = _extract_findings_claude(client, settings.vision_model, narration)
    if not findings.get("summaryMarkdown"):
        findings["summaryMarkdown"] = narration
    return _result(store_url, findings, shots)


# ---------------------------------------------------------------------------
# Gemini computer-use driver (maps Gemini's actions onto the same BrowserComputer)
# ---------------------------------------------------------------------------


def _wheel_delta(direction: str, amount: int) -> tuple[int, int]:
    return {"down": (0, amount), "up": (0, -amount),
            "right": (amount, 0), "left": (-amount, 0)}.get(direction, (0, amount))


def _gemini_needs_confirmation(args: dict) -> bool:
    """Gemini may attach a safety_decision asking for confirmation. This agent is
    autonomous and forbids payment/login, so a confirmation prompt means 'don't'."""
    sd = args.get("safety_decision")
    if not sd:
        return False
    val = str(sd.get("decision") or sd.get("type") or sd if isinstance(sd, dict) else sd).lower()
    return "confirm" in val or "require" in val


def _gemini_action(computer: BrowserComputer, name: str, args: dict, w: int, h: int) -> None:
    """Execute one Gemini function_call against the Playwright page. Gemini sends
    coordinates on a 0-1000 grid, so denormalize to viewport pixels."""
    page = computer.page

    def nx(v) -> int:
        return max(0, min(w - 1, int(float(v) / 1000 * w)))

    def ny(v) -> int:
        return max(0, min(h - 1, int(float(v) / 1000 * h)))

    if name in ("open_web_browser", "search"):
        return  # browser already open; no separate search surface
    if name == "navigate":
        url = args.get("url")
        if url:
            page.goto(url, wait_until="domcontentloaded", timeout=computer.settle_timeout_ms + 24000)
            computer.settle()
        return
    if name == "go_back":
        page.go_back()
        computer.settle()
        return
    if name == "go_forward":
        page.go_forward()
        computer.settle()
        return
    if name == "wait_5_seconds":
        page.wait_for_timeout(5000)
        return
    if name == "hover_at":
        page.mouse.move(nx(args.get("x", 0)), ny(args.get("y", 0)))
        return
    if name == "click_at":
        page.mouse.click(nx(args.get("x", 0)), ny(args.get("y", 0)))
        computer.settle()
        return
    if name == "type_text_at":
        page.mouse.click(nx(args.get("x", 0)), ny(args.get("y", 0)))
        if args.get("clear_before_typing", True):
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
        page.keyboard.type(str(args.get("text", "")))
        if args.get("press_enter"):
            page.keyboard.press("Enter")
        computer.settle()
        return
    if name == "key_combination":
        keys = args.get("keys")
        combo = "+".join(keys) if isinstance(keys, (list, tuple)) else str(keys or "")
        page.keyboard.press(computer._key(combo))
        computer.settle()
        return
    if name in ("scroll_document", "scroll_at"):
        amount = int(args.get("magnitude", 0) or 0) or (h - 100)
        if name == "scroll_at":
            page.mouse.move(nx(args.get("x", w // 2)), ny(args.get("y", h // 2)))
        dx, dy = _wheel_delta(args.get("direction", "down"), amount)
        page.mouse.wheel(dx, dy)
        computer.settle()
        return
    if name == "drag_and_drop":
        page.mouse.move(nx(args.get("x", 0)), ny(args.get("y", 0)))
        page.mouse.down()
        page.mouse.move(nx(args.get("destination_x", 0)), ny(args.get("destination_y", 0)))
        page.mouse.up()
        computer.settle()
        return
    # unknown action -> no-op (the next screenshot lets the model recover)


def _run_gemini(payload: dict, settings: Settings) -> dict:
    from google import genai
    from google.genai import types
    from playwright.sync_api import sync_playwright

    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError(
            "GEMINI_API_KEY is not set on the backend. Set it to run the vision agent "
            "with Gemini, or use MIROFISH_MOCK=1 for a deterministic LLM-free run."
        )

    store_url = _normalize_url(payload.get("storeUrl", ""))
    w, h = settings.vision_viewport_w, settings.vision_viewport_h
    client = genai.Client()
    shots: list[dict] = []
    narration_parts: list[str] = []
    deadline = time.monotonic() + settings.checkout_timeout

    def snap(page) -> bytes:
        png = page.screenshot(type="png")
        if settings.checkout_screenshots and len(shots) < 12:
            shots.append({"name": f"step{len(shots)+1}",
                          "dataUri": "data:image/png;base64," + base64.b64encode(png).decode("ascii")})
        return png

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=settings.checkout_headless)
        context = browser.new_context(viewport={"width": w, "height": h})
        context.set_default_timeout(settings.checkout_nav_timeout)
        page = context.new_page()
        computer = BrowserComputer(
            page, w, h, settings.checkout_settle_ms, settings.checkout_settle_timeout_ms
        )
        try:
            page.goto(store_url, wait_until="domcontentloaded",
                      timeout=settings.checkout_nav_timeout)
            computer.settle()
        except Exception as err:  # noqa: BLE001
            narration_parts.append(f"Could not open the storefront: {str(err)[:160]}")

        config = types.GenerateContentConfig(
            system_instruction=_SYSTEM,
            tools=[types.Tool(
                computer_use=types.ComputerUse(environment=types.Environment.ENVIRONMENT_BROWSER)
            )],
        )
        contents = [types.Content(role="user", parts=[
            types.Part(text=f"The store is open at {store_url}. Begin shopping and stop at "
                            "the payment step."),
            types.Part(inline_data=types.Blob(mime_type="image/png", data=snap(page))),
        ])]

        try:
            for _ in range(settings.vision_max_steps):
                if time.monotonic() > deadline:
                    narration_parts.append("(stopped: time budget reached)")
                    break
                resp = client.models.generate_content(
                    model=settings.gemini_vision_model, contents=contents, config=config
                )
                cand = resp.candidates[0] if resp.candidates else None
                if cand is None or cand.content is None:
                    break
                parts = cand.content.parts or []
                text = "".join(p.text for p in parts if getattr(p, "text", None))
                if text:
                    narration_parts.append(text)
                contents.append(cand.content)
                fc = next((p.function_call for p in parts if getattr(p, "function_call", None)), None)
                if fc is None:
                    break  # no action -> agent is done
                args = dict(fc.args or {})
                if _gemini_needs_confirmation(args):
                    narration_parts.append(f"(declined {fc.name}: safety confirmation required)")
                    fr = types.FunctionResponse(name=fc.name, response={
                        "url": page.url,
                        "error": "Declined: this action needs confirmation; not allowed in an autonomous audit.",
                    })
                    contents.append(types.Content(role="user", parts=[types.Part(function_response=fr)]))
                    continue
                try:
                    _gemini_action(computer, fc.name, args, w, h)
                except Exception as err:  # noqa: BLE001
                    narration_parts.append(f"(error running {fc.name}: {str(err)[:120]})")
                fr = types.FunctionResponse(
                    name=fc.name, response={"url": page.url},
                    parts=[types.FunctionResponsePart(inline_data=types.FunctionResponseBlob(
                        mime_type="image/png", data=snap(page)))],
                )
                contents.append(types.Content(role="user", parts=[types.Part(function_response=fr)]))
        except Exception as err:  # noqa: BLE001
            narration_parts.append(f"(run aborted: {str(err)[:200]})")
        finally:
            context.close()
            browser.close()

    narration = "\n\n".join(narration_parts)
    findings = _extract_findings_gemini(settings.easy_model, narration)
    if not findings.get("summaryMarkdown"):
        findings["summaryMarkdown"] = narration
    return _result(store_url, findings, shots)


# ---------------------------------------------------------------------------
# Mock + entry point
# ---------------------------------------------------------------------------


def _mock(payload: dict) -> dict:
    store_url = _normalize_url(payload.get("storeUrl", "https://example.myshopify.com"))
    frictions = [
        {"step": "product", "severity": "medium", "issue": "(mock) Add-to-cart button below the fold; had to scroll to find it."},
        {"step": "checkout", "severity": "high", "issue": "(mock) Checkout asked to create an account before continuing as guest."},
        {"step": "cart", "severity": "low", "issue": "(mock) No express checkout (Shop Pay) shown."},
    ]
    return {
        "mode": "checkout", "engine": "vision", "storeUrl": store_url,
        "score": 61, "reachedStep": "payment", "steps": [],
        "frictions": frictions, "blockers": [],
        "summaryMarkdown": (
            "# Vision checkout audit (mock)\n\nThe agent reached the payment step. "
            "Biggest friction: account creation forced before guest checkout.\n\n"
            "_Deterministic mock; set MIROFISH_MOCK=0 (and ANTHROPIC_API_KEY + Playwright) for a real run._"
        ),
        "screenshots": [],
    }


def run_vision_checkout(job_id: str, payload: dict, settings: Settings | None = None) -> dict:
    settings = settings or Settings()
    if settings.mock:
        return _mock(payload)
    # Provider is set by the VISION_PROVIDER env var only (no per-run override).
    provider = (settings.vision_provider or "claude").lower()
    return _run_gemini(payload, settings) if provider == "gemini" else _run_claude(payload, settings)
