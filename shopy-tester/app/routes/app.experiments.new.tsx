import { useEffect, useState } from "react";
import { redirect } from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getLatestSnapshot } from "../models/snapshot.server";
import {
  EDITABLE_FIELDS,
  baselineFields,
  isTestable,
  type EditableField,
} from "../models/components";
import { TYPE_LABELS, type ComponentType } from "../models/types";
import { startCheckout, suggestVariant } from "../models/backend.server";
import {
  createAndLaunchExperiment,
  createAndLaunchFullTest,
} from "../models/experiment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const snapshot = await getLatestSnapshot(session.shop);
  if (!snapshot) {
    // The purchasing simulation only needs the store URL, so this page must
    // load even before the store is ingested.
    return {
      shop: session.shop,
      hasSnapshot: false,
      snapshotId: "",
      selected: null,
      options: [],
    };
  }

  const testable = snapshot.components.filter((c) =>
    isTestable(c.type as ComponentType),
  );
  const options = testable.map((c) => ({
    label: `${TYPE_LABELS[c.type as ComponentType]}: ${c.title}`,
    value: c.id,
  }));

  const componentId = new URL(request.url).searchParams.get("componentId");
  const component = componentId
    ? testable.find((c) => c.id === componentId)
    : undefined;

  const selected = component
    ? {
        id: component.id,
        type: component.type as ComponentType,
        title: component.title,
        fields: EDITABLE_FIELDS[component.type as ComponentType],
        baseline: baselineFields(
          component.type as ComponentType,
          (component.data ?? {}) as Record<string, unknown>,
        ),
      }
    : null;

  return {
    shop: session.shop,
    hasSnapshot: true,
    snapshotId: snapshot.id,
    selected,
    options,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  // Full-store purchasing simulation: only needs a store URL, no snapshot.
  if (intent === "launch_purchasing") {
    try {
      const { jobId } = await startCheckout({
        storeUrl: String(form.get("storeUrl") || ""),
        productHandle: String(form.get("productHandle") || "") || undefined,
        storefrontPassword:
          String(form.get("storefrontPassword") || "") || undefined,
        completeOrder: form.get("completeOrder") === "on",
        engine: form.get("engine") === "vision" ? "vision" : "scripted",
      });
      return redirect(`/app/checkout?jobId=${jobId}`);
    } catch (err) {
      return { launchError: err instanceof Error ? err.message : String(err) };
    }
  }

  // Whole-store customer test: no component, no variants.
  if (intent === "launch_full") {
    try {
      const exp = await createAndLaunchFullTest({
        shop: session.shop,
        snapshotId: String(form.get("snapshotId")),
        name: String(form.get("name") || "Full-store customer test"),
      });
      return redirect(`/app/experiments/${exp.id}`);
    } catch (err) {
      return { launchError: err instanceof Error ? err.message : String(err) };
    }
  }

  const componentId = String(form.get("componentId"));

  const component = await prisma.component.findUniqueOrThrow({
    where: { id: componentId },
  });
  const type = component.type as ComponentType;
  const fields = EDITABLE_FIELDS[type];

  if (intent === "suggest") {
    const baseline = baselineFields(
      type,
      (component.data ?? {}) as Record<string, unknown>,
    );
    try {
      const { suggestion } = await suggestVariant(type, component.title, baseline);
      return { suggestion };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // intent === "launch"
  const readFields = (prefix: string) => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = String(form.get(`${prefix}_${f.key}`) ?? "");
    return out;
  };
  try {
    const exp = await createAndLaunchExperiment({
      shop: session.shop,
      snapshotId: String(form.get("snapshotId")),
      componentId,
      name: String(form.get("name") || `${component.title} test`),
      variantA: readFields("a"),
      variantB: readFields("b"),
    });
    return redirect(`/app/experiments/${exp.id}`);
  } catch (err) {
    // Most likely the backend (BACKEND_URL) is unreachable or rejected the call.
    return { launchError: err instanceof Error ? err.message : String(err) };
  }
};

export default function NewExperiment() {
  const { shop, hasSnapshot, snapshotId, selected, options } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [mode, setMode] = useState<"ab" | "full" | "purchasing">("ab");

  const needsSnapshot = mode === "ab" || mode === "full";

  return (
    <s-page heading="New simulation">
      <s-section heading="Test type">
        <s-select
          label="What do you want to run?"
          name="mode"
          value={mode}
          onChange={(e: { currentTarget: { value: string } }) =>
            setMode(e.currentTarget.value as "ab" | "full" | "purchasing")
          }
        >
          <s-option value="ab">A/B test — one component, two variants</s-option>
          <s-option value="full">
            Full-store simulation — synthetic shoppers rate the whole store
          </s-option>
          <s-option value="purchasing">
            Full-store purchasing simulation — an agent buys through checkout (no
            ingestion needed)
          </s-option>
        </s-select>
      </s-section>

      {mode === "purchasing" ? (
        <PurchasingLauncher shop={shop} />
      ) : needsSnapshot && !hasSnapshot ? (
        <s-section>
          <s-banner tone="warning" heading="No store snapshot yet">
            <s-paragraph>
              <s-link href="/app/snapshot">Ingest your store</s-link> first to run
              an A/B test or full-store simulation. The{" "}
              <strong>purchasing simulation</strong> above doesn’t need ingestion.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : mode === "full" ? (
        <FullTestLauncher snapshotId={snapshotId} />
      ) : (
        <>
          <s-section heading="1. Choose a component to test">
            <s-select
              label="Component"
              name="componentId"
              placeholder="Select a component…"
              value={selected?.id ?? ""}
              onChange={(e: { currentTarget: { value: string } }) =>
                submit({ componentId: e.currentTarget.value }, { method: "get" })
              }
            >
              {options.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
          </s-section>

          {selected && (
            <VariantEditor
              key={selected.id}
              snapshotId={snapshotId}
              selected={selected}
            />
          )}
        </>
      )}
    </s-page>
  );
}

function PurchasingLauncher({ shop }: { shop: string }) {
  const launchFetcher = useFetcher();
  const launching = launchFetcher.state !== "idle";
  const launchError = (launchFetcher.data as { launchError?: string } | undefined)
    ?.launchError;

  return (
    <s-section heading="Run a full-store purchasing simulation">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          An agent drives a real browser through your storefront → product → cart →
          checkout and measures friction, stopping before payment. This runs against
          the live store, so it works even before you ingest. Best on a development
          store.
        </s-paragraph>
        <launchFetcher.Form method="post">
          <input type="hidden" name="intent" value="launch_purchasing" />
          <s-stack direction="block" gap="base">
            <s-select label="Engine" name="engine" value="scripted">
              <s-option value="scripted">
                Scripted — fast selector heuristics
              </s-option>
              <s-option value="vision">
                AI vision agent — the model sees the page and shops it (slower)
              </s-option>
            </s-select>
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
            {launchError && (
              <s-banner tone="critical" heading="Could not start the simulation">
                {launchError}
              </s-banner>
            )}
            <button
              type="submit"
              disabled={launching}
              style={{
                padding: "10px 18px",
                background: launching ? "#a0c4b8" : "#008060",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                cursor: launching ? "default" : "pointer",
                width: "fit-content",
              }}
            >
              {launching ? "Starting…" : "Run purchasing simulation"}
            </button>
          </s-stack>
        </launchFetcher.Form>
      </s-stack>
    </s-section>
  );
}

function FullTestLauncher({ snapshotId }: { snapshotId: string }) {
  const launchFetcher = useFetcher();
  const launching = launchFetcher.state !== "idle";
  const launchError = (launchFetcher.data as { launchError?: string } | undefined)
    ?.launchError;

  return (
    <s-section heading="Run a full-store customer test">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          A heavy “boss” agent studies your whole store and designs realistic buyer
          segments, then a swarm of shopper agents (10 per product) browse, decide
          whether to buy, and leave reviews. You get an overall store score, a
          per-product breakdown, top objections, and synthetic reviews.
        </s-paragraph>
        <launchFetcher.Form method="post">
          <input type="hidden" name="intent" value="launch_full" />
          <input type="hidden" name="snapshotId" value={snapshotId} />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Test name"
              name="name"
              defaultValue="Full-store customer test"
            />
            {launchError && (
              <s-banner tone="critical" heading="Could not start the test">
                {launchError}
              </s-banner>
            )}
            <button
              type="submit"
              disabled={launching}
              style={{
                padding: "10px 18px",
                background: launching ? "#a0c4b8" : "#008060",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                cursor: launching ? "default" : "pointer",
                width: "fit-content",
              }}
            >
              {launching ? "Starting…" : "Run full-store test"}
            </button>
          </s-stack>
        </launchFetcher.Form>
      </s-stack>
    </s-section>
  );
}

function VariantEditor({
  snapshotId,
  selected,
}: {
  snapshotId: string;
  selected: {
    id: string;
    type: ComponentType;
    title: string;
    fields: EditableField[];
    baseline: Record<string, string>;
  };
}) {
  const suggestFetcher = useFetcher<{
    suggestion?: Record<string, string>;
    error?: string;
  }>();
  const launchFetcher = useFetcher();
  const [suggestion, setSuggestion] = useState<Record<string, string> | null>(
    null,
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (suggestFetcher.data?.suggestion) {
      setSuggestion(suggestFetcher.data.suggestion);
      setNonce((n) => n + 1);
    }
  }, [suggestFetcher.data]);

  const launching = launchFetcher.state !== "idle";
  const launchError = (launchFetcher.data as { launchError?: string } | undefined)
    ?.launchError;

  const fieldValueB = (key: string) => suggestion?.[key] ?? selected.baseline[key] ?? "";

  return (
    <s-section heading="2. Define variants">
      <s-stack direction="block" gap="base">
        <s-badge>{TYPE_LABELS[selected.type]}</s-badge>

        <s-button
          {...(suggestFetcher.state !== "idle" ? { loading: true } : {})}
          onClick={() =>
            suggestFetcher.submit(
              { intent: "suggest", componentId: selected.id },
              { method: "post" },
            )
          }
        >
          Suggest Variant B with AI
        </s-button>
        {suggestFetcher.data?.error && (
          <s-banner tone="critical" heading="Could not generate a suggestion">
            {suggestFetcher.data.error}
          </s-banner>
        )}

        {/* Native Form + submit button: the most reliable submit path. */}
        <launchFetcher.Form method="post">
          <input type="hidden" name="intent" value="launch" />
          <input type="hidden" name="componentId" value={selected.id} />
          <input type="hidden" name="snapshotId" value={snapshotId} />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Experiment name"
              name="name"
              defaultValue={`${selected.title} test`}
            />
            {selected.fields.map((f) => (
              <s-stack key={f.key} direction="inline" gap="base">
                <s-box inlineSize="50%">
                  <Field
                    label={`Variant A · ${f.label}`}
                    name={`a_${f.key}`}
                    defaultValue={selected.baseline[f.key] ?? ""}
                    multiline={f.multiline}
                  />
                </s-box>
                <s-box inlineSize="50%">
                  <Field
                    key={`b-${f.key}-${nonce}`}
                    label={`Variant B · ${f.label}`}
                    name={`b_${f.key}`}
                    defaultValue={fieldValueB(f.key)}
                    multiline={f.multiline}
                  />
                </s-box>
              </s-stack>
            ))}
            {launchError && (
              <s-banner tone="critical" heading="Could not start simulation">
                {launchError}
              </s-banner>
            )}
            <button
              type="submit"
              disabled={launching}
              style={{
                padding: "10px 18px",
                background: launching ? "#a0c4b8" : "#008060",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                cursor: launching ? "default" : "pointer",
                width: "fit-content",
              }}
            >
              {launching ? "Starting…" : "Run simulation"}
            </button>
          </s-stack>
        </launchFetcher.Form>
      </s-stack>
    </s-section>
  );
}

function Field({
  label,
  name,
  defaultValue,
  multiline,
}: {
  label: string;
  name: string;
  defaultValue: string;
  multiline?: boolean;
}) {
  if (multiline) {
    return (
      <s-text-area label={label} name={name} defaultValue={defaultValue} rows={5} />
    );
  }
  return <s-text-field label={label} name={name} defaultValue={defaultValue} />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
