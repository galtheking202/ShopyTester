import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getCheckoutResult,
  getStatus,
  type CheckoutResult,
} from "../models/backend.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
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

  return { jobId, status, result, error };
};

// Result view for the purchasing simulation. Launching happens from
// /app/experiments/new (the "New simulation" hub), which redirects here with a
// ?jobId once a run has started.
export default function Checkout() {
  const { jobId, status, result, error } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [status, revalidator]);

  return (
    <s-page heading="Purchasing simulation">
      <s-button slot="primary-action" href="/app" variant="tertiary">
        Back
      </s-button>

      {!jobId ? (
        <s-section>
          <s-banner tone="info" heading="No run yet">
            <s-paragraph>
              Start a purchasing simulation from{" "}
              <s-link href="/app/experiments/new">New simulation</s-link>.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : (
        <s-section heading="Result">
          {status === "running" && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Running" />
              <s-text color="subdued">
                Driving the browser through checkout… this can take a minute.
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
