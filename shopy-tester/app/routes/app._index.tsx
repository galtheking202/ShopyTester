import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { statusTone } from "../models/status";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const snapshot = await prisma.shopSnapshot.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { components: true } } },
  });

  const experiments = await prisma.experiment.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      name: true,
      mode: true,
      componentType: true,
      status: true,
      winner: true,
    },
  });

  return {
    snapshot: snapshot
      ? {
          count: snapshot._count.components,
          createdAt: snapshot.createdAt.toISOString(),
        }
      : null,
    experiments,
  };
};

export default function Index() {
  const { snapshot, experiments } = useLoaderData<typeof loader>();

  return (
    <s-page heading="ShopSim — Predictive A/B Testing">
      <s-button slot="primary-action" href="/app/experiments/new" variant="primary">
        New A/B test
      </s-button>

      <s-section heading="Store snapshot">
        {snapshot ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">
                {snapshot.count} components ingested ·{" "}
                {new Date(snapshot.createdAt).toLocaleString()}
              </s-text>
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button href="/app/snapshot">View / re-ingest</s-button>
              <s-button href="/app/experiments/new" variant="primary">
                New A/B test
              </s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">
                No snapshot yet. Ingest your store to begin.
              </s-text>
            </s-paragraph>
            <s-button href="/app/snapshot" variant="primary">
              Ingest store
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Experiments">
        {experiments.length === 0 ? (
          <s-paragraph>
            <s-text color="subdued">
              No experiments yet. Create your first predictive A/B test.
            </s-text>
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {experiments.map((exp) => (
              <s-box
                key={exp.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-link href={`/app/experiments/${exp.id}`}>
                      <s-text type="strong">{exp.name}</s-text>
                    </s-link>
                    <s-text color="subdued">
                      {exp.mode === "full"
                        ? "Full-store customer test"
                        : exp.componentType}
                      {exp.winner ? ` · winner: Variant ${exp.winner}` : ""}
                    </s-text>
                  </s-stack>
                  <s-badge tone={statusTone(exp.status)}>{exp.status}</s-badge>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          Your whole store is decomposed into components and used as shared
          context. Pick one component, define Variant A vs B, and MiroFish
          simulates synthetic shoppers reacting to each — then predicts the
          winner with a confidence score.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
