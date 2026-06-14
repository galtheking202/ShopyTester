import type { ComponentType } from "./types";

// A component field a merchant can edit / A-B test.
export interface EditableField {
  key: string;
  label: string;
  multiline?: boolean;
}

// Which fields are testable + write-backable per component type. Keys match the
// normalized `data` produced by ingest.server.ts.
export const EDITABLE_FIELDS: Record<ComponentType, EditableField[]> = {
  product: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description", multiline: true },
  ],
  collection: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description", multiline: true },
  ],
  page: [
    { key: "title", label: "Title" },
    { key: "description", label: "Body", multiline: true },
  ],
  policy: [{ key: "body", label: "Policy text", multiline: true }],
  brand: [{ key: "description", label: "Brand description", multiline: true }],
  homepage_section: [{ key: "body", label: "Section copy", multiline: true }],
  menu: [], // navigation has no free-text body to A/B test
};

export function isTestable(type: ComponentType): boolean {
  return EDITABLE_FIELDS[type]?.length > 0;
}

// Pull the editable field values out of a component's stored `data`.
export function baselineFields(
  type: ComponentType,
  data: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of EDITABLE_FIELDS[type] ?? []) {
    out[f.key] = data[f.key] == null ? "" : String(data[f.key]);
  }
  return out;
}
