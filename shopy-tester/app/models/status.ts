// Maps an experiment status to a Polaris web-component <s-badge> tone.
export type BadgeTone =
  | "auto"
  | "info"
  | "success"
  | "warning"
  | "critical"
  | "neutral";

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "completed":
    case "applied":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "critical";
    default:
      return "neutral"; // draft
  }
}
