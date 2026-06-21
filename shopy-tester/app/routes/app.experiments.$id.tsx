import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { refreshExperiment } from "../models/experiment.server";
import { applyWinner } from "../models/apply.server";
import { APPLYABLE_TYPES, type ComponentType } from "../models/types";
import { statusTone } from "../models/status";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  await refreshExperiment(params.id!);
  const exp = await prisma.experiment.findUniqueOrThrow({
    where: { id: params.id! },
    include: { variants: true, component: true },
  });
  const full =
    (exp.fullResult as {
      summaryMarkdown?: string;
      products?: {
        title: string;
        score: number;
        topObjections: string[];
        highlight: string;
      }[];
      reviews?: { persona: string; rating: number; text: string }[];
      svgs?: { name: string; dataUri: string }[];
    } | null) ?? null;

  return {
    exp: {
      id: exp.id,
      name: exp.name,
      mode: exp.mode,
      componentType: exp.componentType,
      status: exp.status,
      winner: exp.winner,
      confidence: exp.confidence,
      scoreA: exp.scoreA,
      scoreB: exp.scoreB,
      reportMarkdown: exp.reportMarkdown,
      error: exp.error,
      svgs:
        exp.mode === "full"
          ? full?.svgs ?? []
          : ((exp.svgs as { name: string; dataUri: string }[] | null) ?? []),
      storeScore: exp.storeScore,
      full,
      variants: exp.variants.map((v) => ({
        label: v.label,
        data: v.data as Record<string, string>,
      })),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const exp = await prisma.experiment.findUniqueOrThrow({
    where: { id: params.id! },
    include: { variants: true, component: true },
  });
  if (exp.mode === "full") {
    return { error: "Full-store tests don’t have a variant to apply." };
  }
  if (exp.status !== "completed" || !exp.winner) {
    return { error: "Experiment is not completed yet." };
  }
  const winning = exp.variants.find((v) => v.label === exp.winner);
  if (!winning || !exp.component?.externalId) {
    return { error: "Winning variant or component reference is missing." };
  }
  try {
    await applyWinner(
      admin.graphql,
      exp.componentType as ComponentType,
      exp.component.externalId,
      winning.data as Record<string, string>,
    );
    await prisma.experiment.update({
      where: { id: exp.id },
      data: { status: "applied" },
    });
    return { applied: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

export default function ExperimentDetail() {
  const { exp } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const applyFetcher = useFetcher<{ applied?: boolean; error?: string }>();

  useEffect(() => {
    if (exp.status !== "running") return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [exp.status, revalidator]);

  const variantA = exp.variants.find((v) => v.label === "A");
  const variantB = exp.variants.find((v) => v.label === "B");
  const done = exp.status === "completed" || exp.status === "applied";
  const canApply =
    exp.mode === "ab" &&
    APPLYABLE_TYPES.includes(exp.componentType as ComponentType);
  const isFull = exp.mode === "full";

  return (
    <s-page heading={exp.name}>
      <s-button slot="primary-action" href="/app" variant="tertiary">
        Back
      </s-button>

      <s-section
        heading={
          isFull
            ? "Full-store customer test"
            : `${exp.componentType} · A/B verdict`
        }
      >
        <s-stack direction="block" gap="base">
          <s-badge tone={statusTone(exp.status)}>{exp.status}</s-badge>

          {exp.status === "running" && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner size="base" accessibilityLabel="Simulating" />
              <s-text color="subdued">
                Simulating synthetic shoppers… this can take a few minutes.
              </s-text>
            </s-stack>
          )}

          {exp.status === "failed" && (
            <s-banner tone="critical" heading="Simulation failed">
              {exp.error}
            </s-banner>
          )}

          {done && isFull && (
            <s-banner
              tone="success"
              heading={`Store score: ${Math.round(exp.storeScore ?? 0)}/100`}
            >
              Synthetic shoppers rated the overall store experience.
            </s-banner>
          )}

          {done && !isFull && (
            <s-stack direction="block" gap="base">
              <s-banner tone="success" heading={`Winner: Variant ${exp.winner}`}>
                Confidence {((exp.confidence ?? 0) * 100).toFixed(0)}%
              </s-banner>
              <ScoreRow label="Variant A purchase intent" score={exp.scoreA ?? 0} />
              <ScoreRow label="Variant B purchase intent" score={exp.scoreB ?? 0} />

              {canApply ? (
                <s-button
                  variant="primary"
                  {...(exp.status === "applied" ? { disabled: true } : {})}
                  {...(applyFetcher.state !== "idle" ? { loading: true } : {})}
                  onClick={() => applyFetcher.submit({}, { method: "post" })}
                >
                  {exp.status === "applied"
                    ? "Applied to store"
                    : `Apply Variant ${exp.winner} to store`}
                </s-button>
              ) : (
                <s-text color="subdued">
                  Automatic apply isn’t supported for {exp.componentType}; update
                  it manually in your admin.
                </s-text>
              )}
              {applyFetcher.data?.error && (
                <s-banner tone="critical">{applyFetcher.data.error}</s-banner>
              )}
              {applyFetcher.data?.applied && (
                <s-banner tone="success">
                  Winning variant written to your store.
                </s-banner>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {!isFull && (
        <s-section heading="Variants">
          <s-stack direction="inline" gap="base">
            <s-box inlineSize="50%">
              <VariantCard label="A" data={variantA?.data ?? {}} />
            </s-box>
            <s-box inlineSize="50%">
              <VariantCard label="B" data={variantB?.data ?? {}} />
            </s-box>
          </s-stack>
        </s-section>
      )}

      {isFull && done && (exp.full?.products?.length ?? 0) > 0 && (
        <s-section heading="Per-product results">
          <s-stack direction="block" gap="base">
            {exp.full!.products!.map((p) => (
              <s-box
                key={p.title}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-300">
                  <ScoreRow label={p.title} score={p.score / 100} />
                  {p.topObjections.length > 0 && (
                    <s-text color="subdued">
                      Top objections: {p.topObjections.join("; ")}
                    </s-text>
                  )}
                  {p.highlight && <s-paragraph>“{p.highlight}”</s-paragraph>}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {isFull && done && (exp.full?.reviews?.length ?? 0) > 0 && (
        <s-section heading="Synthetic reviews">
          <s-stack direction="block" gap="small-300">
            {exp.full!.reviews!.map((r, i) => (
              <s-box
                key={i}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-500">
                  <s-stack direction="inline" gap="base" justifyContent="space-between">
                    <s-text type="strong">{r.persona}</s-text>
                    <s-badge>{Math.round(r.rating)}/100</s-badge>
                  </s-stack>
                  <s-paragraph>{r.text}</s-paragraph>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {exp.svgs.length > 0 && (
        <s-section heading="Simulation visuals">
          <s-stack direction="inline" gap="base">
            {exp.svgs.map((s) => (
              <img
                key={s.name}
                src={s.dataUri}
                alt={s.name}
                style={{
                  maxWidth: 360,
                  border: "1px solid #e1e3e5",
                  borderRadius: 8,
                }}
              />
            ))}
          </s-stack>
        </s-section>
      )}

      {(exp.reportMarkdown || exp.full?.summaryMarkdown) && (
        <s-section heading="Report">
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 13,
              margin: 0,
            }}
          >
            {isFull ? exp.full?.summaryMarkdown : exp.reportMarkdown}
          </pre>
        </s-section>
      )}
    </s-page>
  );
}

function ScoreRow({ label, score }: { label: string; score: number }) {
  const pct = Math.round(score * 100);
  return (
    <s-stack direction="block" gap="small-500">
      <s-stack direction="inline" gap="base" justifyContent="space-between">
        <s-text>{label}</s-text>
        <s-text type="strong">{pct}</s-text>
      </s-stack>
      <div
        style={{
          background: "#e1e3e5",
          borderRadius: 6,
          height: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{ width: `${pct}%`, height: "100%", background: "#008060" }}
        />
      </div>
    </s-stack>
  );
}

function VariantCard({
  label,
  data,
}: {
  label: string;
  data: Record<string, string>;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-heading>Variant {label}</s-heading>
        {Object.entries(data).map(([k, v]) => (
          <s-stack key={k} direction="block" gap="small-500">
            <s-text color="subdued">{k}</s-text>
            <s-paragraph>{v}</s-paragraph>
          </s-stack>
        ))}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
