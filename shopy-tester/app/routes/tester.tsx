/**
 * Standalone purchasing-simulation tester — runs OUTSIDE the embedded Shopify
 * admin. This is a top-level route (not under /app), so it renders directly from
 * root.tsx with no App Bridge and no Shopify session: anyone with the URL can
 * point it at a store and run the purchasing simulation.
 *
 * Because there's no Shopify auth here, an optional `TESTER_ACCESS_TOKEN` env
 * gates access (passed as ?token=...). It uses plain HTML, not the s-* Polaris
 * web components (those only render inside the embedded admin).
 */
import { useEffect, type CSSProperties } from "react";
import { redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import {
  getCheckoutResult,
  getStatus,
  startCheckout,
  type CheckoutResult,
} from "../models/backend.server";

function accessOf(request: Request, formToken?: string) {
  const required = process.env.TESTER_ACCESS_TOKEN || "";
  const token =
    formToken ?? new URL(request.url).searchParams.get("token") ?? "";
  return { required: !!required, ok: !required || token === required, token };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const access = accessOf(request);
  if (access.required && !access.ok) {
    return { locked: true as const, token: "" };
  }

  const jobId = new URL(request.url).searchParams.get("jobId");
  let status: "running" | "completed" | "failed" | null = null;
  let result: CheckoutResult | null = null;
  let error: string | null = null;

  if (jobId) {
    try {
      const s = await getStatus(jobId);
      status = s.status;
      if (s.status === "completed") result = await getCheckoutResult(jobId);
      if (s.status === "failed") error = s.error ?? "Run failed.";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    locked: false as const,
    protectedMode: access.required,
    token: access.token,
    jobId,
    status,
    result,
    error,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const token = String(form.get("token") || "");
  const access = accessOf(request, token);
  if (access.required && !access.ok) {
    return { startError: "Invalid access token." };
  }
  try {
    const { jobId } = await startCheckout({
      storeUrl: String(form.get("storeUrl") || ""),
      productHandle: String(form.get("productHandle") || "") || undefined,
      storefrontPassword: String(form.get("storefrontPassword") || "") || undefined,
      completeOrder: form.get("completeOrder") === "on",
      engine: form.get("engine") === "vision" ? "vision" : "scripted",
    });
    const q = token ? `&token=${encodeURIComponent(token)}` : "";
    return redirect(`/tester?jobId=${jobId}${q}`);
  } catch (err) {
    return { startError: err instanceof Error ? err.message : String(err) };
  }
};

// ---------------------------------------------------------------------------

const page: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "32px 20px 64px",
  fontFamily: "Inter, system-ui, sans-serif",
  color: "#1a1a1a",
};
const card: CSSProperties = {
  border: "1px solid #e1e3e5",
  borderRadius: 12,
  padding: 20,
  marginTop: 16,
  background: "#fff",
};
const label: CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, margin: "12px 0 4px" };
const input: CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  border: "1px solid #c9cccf",
  borderRadius: 8,
  fontSize: 14,
  boxSizing: "border-box",
};
const button: CSSProperties = {
  marginTop: 16,
  padding: "10px 18px",
  background: "#008060",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  cursor: "pointer",
};

export default function Tester() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const status = "status" in data ? data.status : null;

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [status, revalidator]);

  if (data.locked) {
    return (
      <main style={page}>
        <h1 style={{ fontSize: 22 }}>Purchasing simulation tester</h1>
        <div style={card}>
          <p>This tester is protected. Enter your access token to continue.</p>
          <form method="get">
            <label htmlFor="token" style={label}>
              Access token
            </label>
            <input id="token" style={input} name="token" type="password" />
            <button style={button} type="submit">
              Unlock
            </button>
          </form>
        </div>
      </main>
    );
  }

  const { token, protectedMode, jobId, result, error } = data;

  return (
    <main style={page}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Purchasing simulation tester</h1>
      <p style={{ color: "#6d7175", marginTop: 0 }}>
        Drive a real browser through a storefront checkout and measure friction —
        no Shopify admin needed. Point it at any store URL (best on a dev store).
      </p>

      {!protectedMode && (
        <div
          style={{
            ...card,
            background: "#fff4f4",
            borderColor: "#e0b3b3",
            color: "#8a1f1f",
            marginTop: 12,
          }}
        >
          ⚠ This tester is <strong>unprotected</strong>. Set a{" "}
          <code>TESTER_ACCESS_TOKEN</code> env var on the app to require a token.
        </div>
      )}

      <div style={card}>
        <form method="post">
          {token ? <input type="hidden" name="token" value={token} /> : null}
          <label htmlFor="engine" style={label}>
            Engine
          </label>
          <select id="engine" style={input} name="engine" defaultValue="scripted">
            <option value="scripted">Scripted — fast selector heuristics</option>
            <option value="vision">
              AI vision agent — Claude sees the page and shops it (slower)
            </option>
          </select>

          <label htmlFor="storeUrl" style={label}>
            Store URL
          </label>
          <input
            id="storeUrl"
            style={input}
            name="storeUrl"
            placeholder="your-store.myshopify.com"
          />

          <label htmlFor="productHandle" style={label}>
            Product handle (optional — first product if blank)
          </label>
          <input id="productHandle" style={input} name="productHandle" />

          <label htmlFor="storefrontPassword" style={label}>
            Storefront password (for password-protected dev stores)
          </label>
          <input
            id="storefrontPassword"
            style={input}
            name="storefrontPassword"
            type="password"
          />

          <label style={{ ...label, display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
            <input type="checkbox" name="completeOrder" />
            Attempt a test order (dev store + Bogus Gateway only)
          </label>

          <button style={button} type="submit">
            Run purchasing simulation
          </button>
        </form>
      </div>

      {jobId && (
        <div style={card}>
          <h2 style={{ fontSize: 17, marginTop: 0 }}>Result</h2>
          {status === "running" && (
            <p style={{ color: "#6d7175" }}>
              Driving the browser through checkout… this can take a minute. (auto-refreshing)
            </p>
          )}
          {error && <p style={{ color: "#8a1f1f" }}>Run failed: {error}</p>}
          {result && <Report result={result} />}
        </div>
      )}
    </main>
  );
}

function Report({ result }: { result: CheckoutResult }) {
  const color =
    result.score >= 70 ? "#008060" : result.score >= 40 ? "#b98900" : "#d72c0d";
  const sevColor = (s: string) =>
    s === "blocker" || s === "high" ? "#d72c0d" : s === "medium" ? "#b98900" : "#5c6ac4";

  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>
        Smoothness score: {result.score}/100
      </div>
      <div style={{ color: "#6d7175", marginBottom: 12 }}>
        Reached the “{result.reachedStep}” stage
        {result.engine ? ` · ${result.engine} engine` : ""}.
      </div>

      {result.steps.length > 0 && (
        <ul style={{ paddingLeft: 18, margin: "8px 0", color: "#444" }}>
          {result.steps.map((s) => (
            <li key={s.name}>
              {s.name}
              {s.loadMs != null ? ` — ${s.loadMs} ms` : ""}
              {s.notes ? ` — ${s.notes}` : ""}
            </li>
          ))}
        </ul>
      )}

      {result.frictions.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Friction points</h3>
          {result.frictions.map((f, i) => (
            <div key={i} style={{ margin: "6px 0", fontSize: 14 }}>
              <span style={{ color: sevColor(f.severity), fontWeight: 700 }}>
                [{f.severity}]
              </span>{" "}
              <span style={{ color: "#6d7175" }}>({f.step})</span> {f.issue}
            </div>
          ))}
        </>
      )}

      {result.screenshots.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
          {result.screenshots.map((s) => (
            <img
              key={s.name}
              src={s.dataUri}
              alt={s.name}
              style={{ maxWidth: 220, border: "1px solid #e1e3e5", borderRadius: 8 }}
            />
          ))}
        </div>
      )}

      {result.summaryMarkdown && (
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13 }}>
          {result.summaryMarkdown}
        </pre>
      )}
    </div>
  );
}
