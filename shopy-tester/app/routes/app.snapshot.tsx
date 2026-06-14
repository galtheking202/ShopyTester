import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ingestShop } from "../models/ingest.server";
import { getLatestSnapshot, saveSnapshot } from "../models/snapshot.server";
import { TYPE_LABELS, type ComponentType } from "../models/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const snapshot = await getLatestSnapshot(session.shop);
  if (!snapshot) return { snapshot: null };

  const counts: Record<string, number> = {};
  for (const c of snapshot.components) counts[c.type] = (counts[c.type] ?? 0) + 1;

  return {
    snapshot: {
      total: snapshot.components.length,
      createdAt: snapshot.createdAt.toISOString(),
      counts,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { components, warnings } = await ingestShop(admin.graphql);
  if (components.length === 0) {
    return {
      ok: false,
      count: 0,
      warnings: warnings.length
        ? warnings
        : ["No components could be ingested from this store."],
    };
  }
  await saveSnapshot(session.shop, components);
  return { ok: true, count: components.length, warnings };
};

export default function Snapshot() {
  const { snapshot } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const ingesting = fetcher.state !== "idle";
  const data = fetcher.data;

  return (
    <s-page heading="Store snapshot">
      <s-button
        slot="primary-action"
        variant="primary"
        {...(ingesting ? { loading: true } : {})}
        onClick={() => fetcher.submit({}, { method: "post" })}
      >
        {snapshot ? "Re-ingest store" : "Ingest store"}
      </s-button>

      <s-section heading="Ingest your store">
        <s-paragraph>
          Pulls products, collections, navigation, pages, policies, brand
          profile, and homepage sections, and turns them into shared context for
          MiroFish simulations.
        </s-paragraph>

        {data?.ok && (
          <s-banner tone="success" heading="Snapshot updated">
            Ingested {data.count} components.
          </s-banner>
        )}
        {data && !data.ok && (
          <s-banner tone="critical" heading="Ingestion failed">
            <s-stack direction="block" gap="small-500">
              {data.warnings?.map((w, i) => (
                <s-paragraph key={i}>{w}</s-paragraph>
              ))}
            </s-stack>
          </s-banner>
        )}
        {data?.ok && data.warnings?.length ? (
          <s-banner tone="warning" heading="Some components were skipped">
            <s-stack direction="block" gap="small-500">
              {data.warnings.map((w, i) => (
                <s-paragraph key={i}>{w}</s-paragraph>
              ))}
            </s-stack>
          </s-banner>
        ) : null}
      </s-section>

      {snapshot && (
        <s-section heading="Current snapshot">
          <s-paragraph>
            <s-text color="subdued">
              {snapshot.total} components ·{" "}
              {new Date(snapshot.createdAt).toLocaleString()}
            </s-text>
          </s-paragraph>
          <s-stack direction="inline" gap="small-300">
            {Object.entries(snapshot.counts).map(([type, n]) => (
              <s-badge key={type}>
                {`${TYPE_LABELS[type as ComponentType] ?? type}: ${n}`}
              </s-badge>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
