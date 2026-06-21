"""Option B: real browser-driven checkout-friction simulation.

Unlike the swarm (which *reasons* about the store from ingested text), this drives
a headless Chromium browser through the live storefront — open a product, add to
cart, go to checkout — and **measures** objective friction: per-step load times,
whether add-to-cart works, whether checkout is reachable, forced account creation,
presence of express checkout, etc. It captures a screenshot per step as evidence.

Designed for **development stores** (handles the storefront password page and,
optionally, completes a test order via Bogus Gateway). On real stores it will not
complete payment and bot-protection may block it — that's expected.

Entry point `run_checkout(job_id, payload, settings)` mirrors the other engines'
shape and plugs into app.py's job table, so /status and /result work unchanged.

NOTE: live-checkout selectors are inherently fragile across themes/Shopify
versions. Every step is wrapped so one failure is recorded as friction/blocker
rather than crashing the whole run.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any
from urllib.parse import urlparse

from runner import Settings

# Severity penalties subtracted from a starting smoothness score of 100.
_PENALTY = {"low": 5, "medium": 12, "high": 22, "blocker": 40}

# Funnel stages, in order — `reachedStep` is the furthest one we got to.
_STAGES = ["storefront", "product", "cart", "checkout", "contact", "shipping", "payment", "complete"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def _score(frictions: list[dict]) -> int:
    score = 100
    for f in frictions:
        score -= _PENALTY.get(f.get("severity", "low"), 5)
    return max(0, min(100, score))


def _friction(step: str, severity: str, issue: str, evidence: str = "") -> dict:
    return {"step": step, "severity": severity, "issue": issue, "evidence": evidence}


# ---------------------------------------------------------------------------
# Browser flow (Playwright, async)
# ---------------------------------------------------------------------------


async def _capture(page, name: str, steps: list[dict], shots: list[dict], settings: Settings) -> None:
    """Record a navigation step's load time + a screenshot."""
    entry = {"name": name, "url": page.url, "loadMs": None, "ok": True, "notes": ""}
    try:
        start = time.monotonic()
        await page.wait_for_load_state("domcontentloaded", timeout=settings.checkout_nav_timeout)
        entry["loadMs"] = int((time.monotonic() - start) * 1000)
    except Exception as err:  # noqa: BLE001
        entry["ok"] = False
        entry["notes"] = f"load wait failed: {str(err)[:120]}"
    steps.append(entry)
    if settings.checkout_screenshots and len(shots) < 8:
        try:
            raw = await page.screenshot(type="jpeg", quality=45, full_page=False)
            shots.append(
                {"name": name, "dataUri": "data:image/jpeg;base64," + base64.b64encode(raw).decode()}
            )
        except Exception:  # noqa: BLE001 - screenshots are best-effort
            pass


async def _maybe_unlock_password(page, password: str | None, frictions: list[dict]) -> None:
    """Dev stores show a storefront password gate; fill it if present."""
    try:
        field = page.locator('input[name="password"]')
        if await field.count() == 0:
            return
        if not password:
            frictions.append(
                _friction("storefront", "blocker", "Storefront is password-protected and no storefrontPassword was provided.")
            )
            return
        await field.first.fill(password)
        await page.locator('button[type="submit"], form[action*="password"] button').first.click()
        await page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception:  # noqa: BLE001
        pass


async def _discover_product_url(page, origin: str, product_handle: str | None) -> str | None:
    if product_handle:
        return f"{origin}/products/{product_handle.strip().lstrip('/')}"
    # Try the storefront products feed (works unless disabled).
    try:
        resp = await page.request.get(f"{origin}/products.json?limit=1")
        if resp.ok:
            data = await resp.json()
            items = data.get("products") or []
            if items and items[0].get("handle"):
                return f"{origin}/products/{items[0]['handle']}"
    except Exception:  # noqa: BLE001
        pass
    # Fall back to the catch-all collection and grab the first product link.
    try:
        await page.goto(f"{origin}/collections/all", wait_until="domcontentloaded", timeout=20000)
        link = page.locator('a[href*="/products/"]').first
        if await link.count() > 0:
            href = await link.get_attribute("href")
            if href:
                return href if href.startswith("http") else origin + href
    except Exception:  # noqa: BLE001
        pass
    return None


async def _run(payload: dict, settings: Settings) -> dict:
    from playwright.async_api import async_playwright  # lazy import

    store_url = _normalize_url(payload.get("storeUrl", ""))
    origin = _origin(store_url)
    product_handle = payload.get("productHandle")
    password = payload.get("storefrontPassword") or settings.storefront_password or None
    complete_order = bool(payload.get("completeOrder", False))

    steps: list[dict] = []
    shots: list[dict] = []
    frictions: list[dict] = []
    blockers: list[str] = []
    reached = "storefront"

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=settings.checkout_headless)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 ShopSimCheckoutBot"
            ),
        )
        context.set_default_timeout(settings.checkout_nav_timeout)
        page = await context.new_page()
        try:
            # 1) Storefront (handle password gate).
            await page.goto(store_url, wait_until="domcontentloaded", timeout=settings.checkout_nav_timeout)
            await _maybe_unlock_password(page, password, frictions)
            await _capture(page, "storefront", steps, shots, settings)

            # 2) Product page.
            product_url = await _discover_product_url(page, origin, product_handle)
            if not product_url:
                blockers.append("Could not find any product to test (no products.json, no product links).")
            else:
                await page.goto(product_url, wait_until="domcontentloaded", timeout=settings.checkout_nav_timeout)
                reached = "product"
                await _capture(page, "product", steps, shots, settings)
                await _add_to_cart(page, origin, frictions, blockers)

                # 3) Cart.
                await page.goto(f"{origin}/cart", wait_until="domcontentloaded", timeout=settings.checkout_nav_timeout)
                reached = "cart"
                await _capture(page, "cart", steps, shots, settings)
                await _check_express_checkout(page, frictions)

                # 4) Checkout.
                reached = await _go_to_checkout(page, origin, steps, shots, settings, frictions, blockers, reached)
                if reached in ("checkout", "contact"):
                    await _inspect_checkout(page, frictions)
                    if complete_order:
                        reached = await _attempt_test_order(page, steps, shots, settings, frictions, blockers, reached)
        except Exception as err:  # noqa: BLE001 - record, don't crash the job
            blockers.append(f"Run aborted: {str(err)[:200]}")
        finally:
            await context.close()
            await browser.close()

    # Slow-step friction from measured load times.
    for s in steps:
        if s.get("loadMs") and s["loadMs"] > settings.checkout_slow_step_ms:
            frictions.append(
                _friction(s["name"], "medium", f"Slow {s['name']} load ({s['loadMs']} ms).", s["url"])
            )
    for b in blockers:
        frictions.append(_friction(reached, "blocker", b))

    score = _score(frictions)
    summary = await _summarize(store_url, reached, score, steps, frictions, blockers, settings)
    return {
        "mode": "checkout",
        "storeUrl": store_url,
        "score": score,
        "reachedStep": reached,
        "steps": steps,
        "frictions": frictions,
        "blockers": blockers,
        "summaryMarkdown": summary,
        "screenshots": shots,
    }


async def _add_to_cart(page, origin: str, frictions: list[dict], blockers: list[str]) -> None:
    # Standard Shopify product form add button; try a few selectors.
    selectors = ['button[name="add"]', 'form[action*="/cart/add"] [type="submit"]', 'button[type="submit"]:has-text("Add")']
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if await btn.count() == 0:
                continue
            if await btn.is_disabled():
                frictions.append(_friction("product", "high", "Add-to-cart button is disabled (likely out of stock).", sel))
                return
            await btn.click(timeout=8000)
            await page.wait_for_timeout(1500)  # allow cart drawer / AJAX
            return
        except Exception:  # noqa: BLE001
            continue
    blockers.append("Could not add the product to the cart (no working add-to-cart button found).")


async def _check_express_checkout(page, frictions: list[dict]) -> None:
    try:
        express = page.locator('[data-shopify="dynamic-checkout-cart"], .shopify-payment-button, [aria-label*="Shop Pay"]')
        if await express.count() == 0:
            frictions.append(
                _friction("cart", "low", "No express/accelerated checkout (Shop Pay/PayPal) detected — adds checkout steps.")
            )
    except Exception:  # noqa: BLE001
        pass


async def _go_to_checkout(page, origin, steps, shots, settings, frictions, blockers, reached) -> str:
    # Prefer clicking the cart's checkout button; fall back to /checkout.
    try:
        btn = page.locator('[name="checkout"], button:has-text("Checkout"), a[href*="/checkout"]').first
        if await btn.count() > 0:
            await btn.click(timeout=8000)
        else:
            await page.goto(f"{origin}/checkout", wait_until="domcontentloaded", timeout=settings.checkout_nav_timeout)
        await page.wait_for_load_state("domcontentloaded", timeout=settings.checkout_nav_timeout)
    except Exception:
        try:
            await page.goto(f"{origin}/checkout", wait_until="domcontentloaded", timeout=settings.checkout_nav_timeout)
        except Exception as err:  # noqa: BLE001
            blockers.append(f"Checkout not reachable: {str(err)[:120]}")
            return reached
    await _capture(page, "checkout", steps, shots, settings)
    # Forced account creation: checkout bounced to a login/account page.
    if "/account/login" in page.url or "/account" in page.url and "checkout" not in page.url:
        frictions.append(_friction("checkout", "high", "Checkout requires logging in / creating an account (no guest checkout)."))
        return "checkout"
    return "contact"


async def _inspect_checkout(page, frictions: list[dict]) -> None:
    try:
        # Guest email field expected on the contact step.
        email = page.locator('input[type="email"], input[name="email"], #email')
        if await email.count() == 0:
            frictions.append(_friction("contact", "medium", "No guest email field found on the first checkout step."))
        # Required phone number is a known friction point.
        phone = page.locator('input[type="tel"], input[name*="phone"]')
        if await phone.count() > 0:
            frictions.append(_friction("contact", "low", "Checkout asks for a phone number (optional fields reduce friction)."))
    except Exception:  # noqa: BLE001
        pass


async def _attempt_test_order(page, steps, shots, settings, frictions, blockers, reached) -> str:
    """Best-effort Bogus Gateway test order (dev stores only)."""
    try:
        await page.locator('input[type="email"], #email').first.fill("shopsim+test@example.com")
        for field, val in {
            "firstName": "Test", "lastName": "Shopper", "address1": "151 O'Connor St",
            "city": "Ottawa", "postalCode": "K2P 2L8", "zip": "K2P 2L8",
        }.items():
            loc = page.locator(f'input[name*="{field}"]')
            if await loc.count() > 0:
                await loc.first.fill(val)
        await _capture(page, "shipping", steps, shots, settings)
        reached = "shipping"
        # NOTE: completing payment requires the Bogus Gateway test card and the
        # checkout's payment iframe; left as a follow-up to keep this safe by default.
        frictions.append(_friction("payment", "low", "Test-order completion stopped before payment (enable Bogus Gateway + card entry to finish)."))
    except Exception as err:  # noqa: BLE001
        blockers.append(f"Test order attempt failed: {str(err)[:120]}")
    return reached


# ---------------------------------------------------------------------------
# Summary (optional LLM, deterministic fallback)
# ---------------------------------------------------------------------------


async def _summarize(store_url, reached, score, steps, frictions, blockers, settings) -> str:
    data = {
        "storeUrl": store_url, "reachedStep": reached, "smoothnessScore": score,
        "steps": steps, "frictions": frictions, "blockers": blockers,
    }
    try:
        import gemini  # optional

        out = await asyncio.to_thread(
            gemini.chat_json,
            "A bot drove a real headless browser through this store's checkout and measured friction. "
            "Write a concise merchant report: how far it got, the biggest friction points (ordered by "
            "severity) with concrete fixes, and any hard blockers.\n\n"
            f"DATA (JSON):\n{json.dumps(data, ensure_ascii=False)[:8000]}\n\n"
            'Return ONLY JSON: {"markdown": "<GitHub-flavored Markdown report>"}',
            model=settings.boss_model,
            temperature=0.5,
            max_output_tokens=1500,
        )
        if out.get("markdown"):
            return out["markdown"]
    except Exception:  # noqa: BLE001 - fall back to a deterministic summary
        pass
    lines = [
        f"# Checkout friction report\n",
        f"**Smoothness score:** {score}/100 — reached the **{reached}** stage.\n",
    ]
    if frictions:
        lines.append("## Friction points")
        for f in sorted(frictions, key=lambda x: _PENALTY.get(x["severity"], 0), reverse=True):
            lines.append(f"- **[{f['severity']}]** ({f['step']}) {f['issue']}")
    if blockers:
        lines.append("\n## Blockers")
        lines += [f"- {b}" for b in blockers]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Mock + entry point
# ---------------------------------------------------------------------------


def _mock(payload: dict) -> dict:
    store_url = _normalize_url(payload.get("storeUrl", "https://example.myshopify.com"))
    frictions = [
        _friction("cart", "low", "No express/accelerated checkout (Shop Pay/PayPal) detected — adds checkout steps."),
        _friction("checkout", "medium", "Shipping cost only revealed at the checkout step."),
        _friction("storefront", "medium", "Slow storefront load (4200 ms)."),
    ]
    steps = [
        {"name": "storefront", "url": store_url, "loadMs": 4200, "ok": True, "notes": ""},
        {"name": "product", "url": f"{store_url}/products/sample", "loadMs": 1300, "ok": True, "notes": ""},
        {"name": "cart", "url": f"{store_url}/cart", "loadMs": 900, "ok": True, "notes": ""},
        {"name": "checkout", "url": f"{store_url}/checkout", "loadMs": 1500, "ok": True, "notes": ""},
    ]
    score = _score(frictions)
    return {
        "mode": "checkout",
        "storeUrl": store_url,
        "score": score,
        "reachedStep": "contact",
        "steps": steps,
        "frictions": frictions,
        "blockers": [],
        "summaryMarkdown": (
            f"# Checkout friction report (mock)\n\nSmoothness **{score}/100**, reached the contact step.\n\n"
            "_Deterministic mock; set MIROFISH_MOCK=0 (and install Playwright) for a real run._"
        ),
        "screenshots": [],
    }


def run_checkout(job_id: str, payload: dict, settings: Settings | None = None) -> dict:
    settings = settings or Settings()
    if settings.mock:
        return _mock(payload)
    return asyncio.run(asyncio.wait_for(_run(payload, settings), timeout=settings.checkout_timeout))
