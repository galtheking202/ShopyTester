import type { ComponentType, IngestedComponent } from "./types";
import { TYPE_LABELS } from "./types";

// Lightweight HTML -> plain text. MiroFish reads markdown/text, so we strip
// theme markup down to readable prose.
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Render a single component's canonical markdown from its normalized data.
// `overrides` lets a variant substitute specific fields (e.g. title, body).
export function renderComponentMarkdown(
  type: ComponentType,
  title: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  const d = { ...data, ...overrides };
  const lines: string[] = [];
  const label = TYPE_LABELS[type];
  lines.push(`## ${label}: ${(overrides.title as string) ?? title}`);

  const get = (k: string) => (d[k] == null ? "" : String(d[k]));

  switch (type) {
    case "product": {
      if (get("productType")) lines.push(`- Type: ${get("productType")}`);
      if (get("vendor")) lines.push(`- Vendor: ${get("vendor")}`);
      if (get("priceRange")) lines.push(`- Price: ${get("priceRange")}`);
      if (Array.isArray(d.tags) && d.tags.length)
        lines.push(`- Tags: ${(d.tags as string[]).join(", ")}`);
      if (get("imageAlt")) lines.push(`- Image alt text: ${get("imageAlt")}`);
      if (get("description")) lines.push("", get("description"));
      break;
    }
    case "collection":
    case "page": {
      if (get("description")) lines.push("", get("description"));
      break;
    }
    case "policy": {
      if (get("policyType")) lines.push(`- Policy type: ${get("policyType")}`);
      if (get("body")) lines.push("", get("body"));
      break;
    }
    case "brand": {
      if (get("currencyCode")) lines.push(`- Currency: ${get("currencyCode")}`);
      if (get("description")) lines.push("", get("description"));
      break;
    }
    case "menu": {
      if (Array.isArray(d.items) && d.items.length) {
        lines.push("- Items:");
        for (const item of d.items as Array<{ title: string; url?: string }>) {
          lines.push(`  - ${item.title}${item.url ? ` (${item.url})` : ""}`);
        }
      }
      break;
    }
    case "homepage_section": {
      if (get("sectionType")) lines.push(`- Section type: ${get("sectionType")}`);
      if (get("body")) lines.push("", get("body"));
      break;
    }
  }

  return lines.join("\n").trim();
}

// Concatenate every ingested component into a single shop-context document.
export function buildShopContext(
  shop: string,
  components: Pick<IngestedComponent, "type" | "title" | "markdown">[],
): string {
  const grouped: Record<string, string[]> = {};
  for (const c of components) {
    (grouped[c.type] ??= []).push(c.markdown);
  }

  const out: string[] = [];
  out.push(`# Store snapshot: ${shop}`);
  out.push(
    "This document describes the storefront a shopper experiences. Use it as " +
      "shared context when judging the component variant provided separately.",
  );

  const order: ComponentType[] = [
    "brand",
    "menu",
    "collection",
    "product",
    "page",
    "policy",
    "homepage_section",
  ];
  for (const type of order) {
    const items = grouped[type];
    if (!items || items.length === 0) continue;
    out.push("", `# ${TYPE_LABELS[type]}s`);
    out.push(...items);
  }

  return out.join("\n\n");
}

// A compact, structured description of the store's likely customers, derived
// from the ingested snapshot. Sent to the backend, which turns it into shopper
// personas seeded into the simulation. No LLM needed here.
export interface AudienceBrief {
  brandName: string;
  brandVoice: string;
  currency: string;
  priceLow: number | null;
  priceHigh: number | null;
  categories: string[];
  sampleProducts: string[];
}

export function buildAudienceBrief(
  components: { type: string; title: string; data: unknown }[],
): AudienceBrief {
  const brand = components.find((c) => c.type === "brand");
  const brandData = (brand?.data ?? {}) as Record<string, unknown>;
  const products = components.filter((c) => c.type === "product");

  const prices: number[] = [];
  const typeSet = new Set<string>();
  const tagCounts: Record<string, number> = {};

  for (const p of products) {
    const d = (p.data ?? {}) as Record<string, unknown>;
    for (const n of String(d.priceRange ?? "").match(/\d+(\.\d+)?/g) ?? []) {
      const v = Number(n);
      if (!Number.isNaN(v)) prices.push(v);
    }
    if (d.productType) typeSet.add(String(d.productType));
    if (Array.isArray(d.tags)) {
      for (const t of d.tags as string[]) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);
  const categories = [...new Set([...typeSet, ...topTags])].slice(0, 10);

  return {
    brandName: brand?.title ?? "",
    brandVoice: String(brandData.description ?? ""),
    currency: String(brandData.currencyCode ?? ""),
    priceLow: prices.length ? Math.min(...prices) : null,
    priceHigh: prices.length ? Math.max(...prices) : null,
    categories,
    sampleProducts: products.slice(0, 5).map((p) => p.title),
  };
}
