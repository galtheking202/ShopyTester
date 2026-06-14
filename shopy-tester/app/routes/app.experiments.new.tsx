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
import { suggestVariant } from "../models/backend.server";
import { createAndLaunchExperiment } from "../models/experiment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const snapshot = await getLatestSnapshot(session.shop);
  if (!snapshot) {
    return { hasSnapshot: false, snapshotId: "", selected: null, options: [] };
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

  return { hasSnapshot: true, snapshotId: snapshot.id, selected, options };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
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
  const exp = await createAndLaunchExperiment({
    shop: session.shop,
    snapshotId: String(form.get("snapshotId")),
    componentId,
    name: String(form.get("name") || `${component.title} test`),
    variantA: readFields("a"),
    variantB: readFields("b"),
  });
  throw redirect(`/app/experiments/${exp.id}`);
};

export default function NewExperiment() {
  const { hasSnapshot, snapshotId, selected, options } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();

  if (!hasSnapshot) {
    return (
      <s-page heading="New A/B test">
        <s-section>
          <s-banner tone="warning" heading="No store snapshot yet">
            <s-paragraph>
              <s-link href="/app/snapshot">Ingest your store</s-link> first to
              create an experiment.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="New A/B test">
      <s-section heading="1. Choose a component to test">
        <s-select
          label="Component"
          name="componentId"
          placeholder="Select a component…"
          value={selected?.id ?? ""}
          onChange={(e: any) =>
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
        <VariantEditor key={selected.id} snapshotId={snapshotId} selected={selected} />
      )}
    </s-page>
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

  const launch = (e: any) => {
    const formEl = (e.currentTarget as HTMLElement).closest("form");
    if (formEl) launchFetcher.submit(formEl, { method: "post" });
  };

  const fieldValueB = (key: string) => suggestion?.[key] ?? selected.baseline[key] ?? "";

  return (
    <>
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

          <form>
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
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section>
        <s-button
          variant="primary"
          {...(launchFetcher.state !== "idle" ? { loading: true } : {})}
          onClick={launch}
        >
          Run simulation
        </s-button>
      </s-section>
    </>
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
