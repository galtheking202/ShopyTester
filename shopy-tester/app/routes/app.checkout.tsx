import { useEffect } from "react";
import { redirect } from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getCheckoutResult,
  getStatus,
  startCheckout,
  type CheckoutResult,
} from "../models/backend.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobId = new URL(request.url).searchParams.get("jobId");

  let status: "running" | "completed" | "failed" | null = null;
  let result: CheckoutResult | null = null;
  let error: string | null = null;

  if (jobId) {
    try {
      const s = await getStatus(jobId);
      status = s.status;
      if (s.status === "completed") result = await getCheckoutResult(jobId);
      if (s.status === "failed") error = s.error ?? "Checkout run failed.";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return { shop: session.shop, jobId, status, result, error };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  try {
    const { jobId } = await startCheckout({
      storeUrl: String(form.get("storeUrl") || ""),
      productHandle: String(form.get("productHandle") || "") || undefined,
      storefrontPassword: String(form.get("storefrontPassword") || "") || undefined,
      completeOrder: form.get("completeOrder") === "on",
    });
    return redirect(`/app/checkout?jobId=${jobId}`);
  } catch (err) {
    return { startError: err instanceof Error ? err.message : String(err) };
  }
};

export default function Checkout() {
  const { shop, jobId, status, result, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ startError?: string }>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [status, revalidator]);

  const starting = fetcher.state !== "idle";
  const startError = fetcher.data?.startError;

  return (
    <s-page heading="Checkout friction test">
      <s-button slot="primary-action" href="/app" variant="tertiary">
        Back
      </s-button>

      <s-section heading="Run a real checkout">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Drives a real headless browser through your storefront → product → cart →
            checkout and measures friction: per-step load times, whether add-to-cart and
            checkout work, forced account creation, missing express checkout, and more.
            Works best on a development store (handles the storefront password).
          </s-paragraph>
          <fetcher.Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Store URL"
                name="storeUrl"
                defaultValue={`https://${shop}`}
              />
              <s-text-field
                label="Product handle (optional — first product if blank)"
                name="productHandle"
                defaultValue=""
              />
              <s-text-field
                label="Storefront password (for password-protected dev stores)"
                name="storefrontPassword"
                defaultValue=""
              />
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" name="completeOrder" />
                <s-text>Attempt a test order (dev store + Bogus Gateway only)</s-text>
              </label>
              {startError && (
                <s-banner tone="critical" heading="Could not start the run">
                  {startError}
                </s-banner>
              )}
              <button
                type="submit"
                disabled={starting}
                style={{
                  padding: "10px 18px",
                  background: starting ? "#a0c4b8" : "#008060",
                  color: "white",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 14,
                  cursor: starting ? "default" : "pointer",
                  width: "fit-content",
                }}
              >
                {starting ? "Starting…" : "Run checkout test"}
              </button>
            </s-stack>
          </fetcher.Form>
        </s-stack>
      </s-section>

      {jobId && (
        <s-section heading="Result">
          {status === "running" && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Running" />
              <s-text color="subdued">
                Driving the browser through checkout… this can take up to a minute.
              </s-text>
            </s-stack>
          )}
          {error && (
            <s-banner tone="critical" heading="Run failed">
              {error}
            </s-banner>
          )}
          {result && <CheckoutReport result={result} />}
        </s-section>
      )}
    </s-page>
  );
}

function CheckoutReport({ result }: { result: CheckoutResult }) {
  const toneFor = (sev: string) =>
    sev === "blocker" || sev === "high"
      ? "critical"
      : sev === "medium"
        ? "warning"
        : "info";

  return (
    <s-stack direction="block" gap="base">
      <s-banner
        tone={result.score >= 70 ? "success" : result.score >= 40 ? "warning" : "critical"}
        heading={`Smoothness score: ${result.score}/100`}
      >
        Reached the “{result.reachedStep}” stage.
      </s-banner>

      <s-stack direction="block" gap="small-300">
        {result.steps.map((s) => (
          <s-stack key={s.name} direction="inline" gap="base" justifyContent="space-between">
            <s-text>
              {s.name}
              {s.notes ? ` — ${s.notes}` : ""}
            </s-text>
            <s-text color="subdued">{s.loadMs == null ? "—" : `${s.loadMs} ms`}</s-text>
          </s-stack>
        ))}
      </s-stack>

      {result.frictions.length > 0 && (
        <s-stack direction="block" gap="small-300">
          <s-heading>Friction points</s-heading>
          {result.frictions.map((f, i) => (
            <s-banner key={i} tone={toneFor(f.severity)}>
              <s-text type="strong">[{f.severity}]</s-text> ({f.step}) {f.issue}
            </s-banner>
          ))}
        </s-stack>
      )}

      {result.screenshots.length > 0 && (
        <s-stack direction="block" gap="small-300">
          <s-heading>Screenshots</s-heading>
          <s-stack direction="inline" gap="base">
            {result.screenshots.map((s) => (
              <img
                key={s.name}
                src={s.dataUri}
                alt={s.name}
                style={{ maxWidth: 240, border: "1px solid #e1e3e5", borderRadius: 8 }}
              />
            ))}
          </s-stack>
        </s-stack>
      )}

      {result.summaryMarkdown && (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
            margin: 0,
          }}
        >
          {result.summaryMarkdown}
        </pre>
      )}
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
