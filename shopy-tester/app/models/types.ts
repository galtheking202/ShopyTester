// Shared domain types for ShopSim ingestion + experiments.

export type ComponentType =
  | "product"
  | "collection"
  | "menu"
  | "page"
  | "policy"
  | "brand"
  | "homepage_section";

// A normalized, store-agnostic representation of one ingested unit.
export interface IngestedComponent {
  type: ComponentType;
  externalId: string | null; // Shopify GID or handle, used for write-back
  handle: string | null;
  title: string;
  // Normalized fields used both for markdown serialization and for write-back.
  data: Record<string, unknown>;
  markdown: string;
}

export interface IngestResult {
  components: IngestedComponent[];
  // Per-type ingestion errors (graceful degradation), surfaced in the UI.
  warnings: string[];
}

// Human-readable labels.
export const TYPE_LABELS: Record<ComponentType, string> = {
  product: "Product",
  collection: "Collection",
  menu: "Navigation menu",
  page: "Page",
  policy: "Policy",
  brand: "Brand profile",
  homepage_section: "Homepage section",
};
