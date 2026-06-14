import type { IngestedComponent, IngestResult } from "./types";
import { htmlToText, renderComponentMarkdown } from "./serialize.server";

// Minimal shape of the Admin GraphQL client returned by authenticate.admin().
type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

async function run<T>(
  graphql: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }
  if (!json.data) throw new Error("No data returned");
  return json.data;
}

function comp(
  type: IngestedComponent["type"],
  externalId: string | null,
  handle: string | null,
  title: string,
  data: Record<string, unknown>,
): IngestedComponent {
  return {
    type,
    externalId,
    handle,
    title,
    data,
    markdown: renderComponentMarkdown(type, title, data),
  };
}

const MONEY = (m?: { amount?: string; currencyCode?: string }) =>
  m?.amount ? `${m.amount} ${m.currencyCode ?? ""}`.trim() : "";

async function ingestProducts(
  graphql: GraphqlClient,
  out: IngestedComponent[],
  cap = 250,
) {
  const query = `#graphql
    query Products($cursor: String) {
      products(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id handle title descriptionHtml tags productType vendor
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          featuredImage { altText }
        }
      }
    }`;
  let cursor: string | null = null;
  do {
    const data: any = await run<any>(graphql, query, { cursor });
    const conn: any = data.products;
    for (const p of conn.nodes) {
      const min = MONEY(p.priceRangeV2?.minVariantPrice);
      const max = MONEY(p.priceRangeV2?.maxVariantPrice);
      out.push(
        comp("product", p.id, p.handle, p.title, {
          description: htmlToText(p.descriptionHtml),
          descriptionHtml: p.descriptionHtml ?? "",
          productType: p.productType ?? "",
          vendor: p.vendor ?? "",
          tags: p.tags ?? [],
          priceRange: min === max || !max ? min : `${min} – ${max}`,
          imageAlt: p.featuredImage?.altText ?? "",
        }),
      );
      if (out.filter((c) => c.type === "product").length >= cap) return;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

async function ingestCollections(
  graphql: GraphqlClient,
  out: IngestedComponent[],
  cap = 100,
) {
  const query = `#graphql
    query Collections($cursor: String) {
      collections(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle title descriptionHtml }
      }
    }`;
  let cursor: string | null = null;
  let count = 0;
  do {
    const data: any = await run<any>(graphql, query, { cursor });
    const conn: any = data.collections;
    for (const c of conn.nodes) {
      out.push(
        comp("collection", c.id, c.handle, c.title, {
          description: htmlToText(c.descriptionHtml),
          descriptionHtml: c.descriptionHtml ?? "",
        }),
      );
      if (++count >= cap) return;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

async function ingestMenus(graphql: GraphqlClient, out: IngestedComponent[]) {
  const query = `#graphql
    query Menus {
      menus(first: 25) {
        nodes {
          id handle title
          items { title url items { title url } }
        }
      }
    }`;
  const data: any = await run<any>(graphql, query);
  for (const m of data.menus.nodes) {
    const items: Array<{ title: string; url?: string }> = [];
    for (const i of m.items ?? []) {
      items.push({ title: i.title, url: i.url });
      for (const sub of i.items ?? [])
        items.push({ title: `↳ ${sub.title}`, url: sub.url });
    }
    out.push(comp("menu", m.id, m.handle, m.title, { items }));
  }
}

async function ingestPages(
  graphql: GraphqlClient,
  out: IngestedComponent[],
  cap = 100,
) {
  const query = `#graphql
    query Pages($cursor: String) {
      pages(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle title body }
      }
    }`;
  let cursor: string | null = null;
  let count = 0;
  do {
    const data: any = await run<any>(graphql, query, { cursor });
    const conn: any = data.pages;
    for (const p of conn.nodes) {
      out.push(
        comp("page", p.id, p.handle, p.title, {
          description: htmlToText(p.body),
          body: p.body ?? "",
        }),
      );
      if (++count >= cap) return;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

async function ingestShopBrandAndPolicies(
  graphql: GraphqlClient,
  out: IngestedComponent[],
) {
  const query = `#graphql
    query ShopInfo {
      shop {
        name myshopifyDomain currencyCode description
        shopPolicies { id type title body url }
      }
    }`;
  const data: any = await run<any>(graphql, query);
  const shop = data.shop;
  out.push(
    comp("brand", shop.myshopifyDomain ?? null, null, shop.name, {
      currencyCode: shop.currencyCode ?? "",
      description: shop.description ?? "",
    }),
  );
  for (const pol of shop.shopPolicies ?? []) {
    if (!pol.body) continue;
    out.push(
      comp("policy", pol.id, null, pol.title ?? pol.type, {
        policyType: pol.type ?? "",
        body: htmlToText(pol.body),
      }),
    );
  }
}

// Homepage sections live in the Online Store theme's templates/index.json.
// This is the most fragile ingester (theme shapes vary), so it is isolated and
// best-effort: it extracts human-readable copy from section settings.
async function ingestHomepageSections(
  graphql: GraphqlClient,
  out: IngestedComponent[],
) {
  const query = `#graphql
    query MainThemeIndex {
      themes(first: 1, roles: [MAIN]) {
        nodes {
          id name
          files(filenames: ["templates/index.json"], first: 1) {
            nodes {
              filename
              body {
                ... on OnlineStoreThemeFileBodyText { content }
              }
            }
          }
        }
      }
    }`;
  const data: any = await run<any>(graphql, query);
  const theme = data.themes?.nodes?.[0];
  const content = theme?.files?.nodes?.[0]?.body?.content;
  if (!content) return;

  const parsed = JSON.parse(content) as {
    sections?: Record<
      string,
      { type?: string; settings?: Record<string, unknown> }
    >;
    order?: string[];
  };
  const sections = parsed.sections ?? {};
  const order = parsed.order ?? Object.keys(sections);

  const TEXTISH =
    /(title|heading|subheading|subtext|text|content|caption|button_label|cta)/i;
  for (const key of order) {
    const section = sections[key];
    if (!section) continue;
    const settings = section.settings ?? {};
    const parts: string[] = [];
    for (const [k, v] of Object.entries(settings)) {
      if (typeof v === "string" && v.trim() && TEXTISH.test(k)) {
        parts.push(htmlToText(v));
      }
    }
    if (parts.length === 0) continue;
    const sectionType = section.type ?? "section";
    out.push(
      comp("homepage_section", key, key, `${sectionType} (${key})`, {
        sectionType,
        body: parts.join("\n\n"),
        sectionKey: key,
      }),
    );
  }
}

// Run every ingester independently; a failure in one only records a warning.
export async function ingestShop(graphql: GraphqlClient): Promise<IngestResult> {
  const components: IngestedComponent[] = [];
  const warnings: string[] = [];

  const steps: Array<[string, () => Promise<void>]> = [
    ["brand & policies", () => ingestShopBrandAndPolicies(graphql, components)],
    ["menus", () => ingestMenus(graphql, components)],
    ["collections", () => ingestCollections(graphql, components)],
    ["products", () => ingestProducts(graphql, components)],
    ["pages", () => ingestPages(graphql, components)],
    ["homepage sections", () => ingestHomepageSections(graphql, components)],
  ];

  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not ingest ${name}: ${msg.slice(0, 240)}`);
    }
  }

  return { components, warnings };
}
