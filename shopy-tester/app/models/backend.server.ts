// HTTP client for the ShopSim backend service (MiroFish + variant generation).
// In production this points at the Railway container; locally at the worker.

import type { ComponentType } from "./types";

const BASE =
  process.env.BACKEND_URL ||
  process.env.MIROFISH_WORKER_URL ||
  "http://localhost:8800";

export interface RunPayload {
  shopContext: string;
  // "ab" = score two component variants; "full" = whole-store audit.
  mode: "ab" | "full";
  // Required for "ab"; omitted for "full".
  variantA?: string;
  variantB?: string;
  requirement: string;
  componentType: string;
  // Structured store-customer brief; the backend turns it into shopper personas.
  audienceBrief?: unknown;
}

// A `type` (not `interface`) so it gets an implicit index signature and stays
// assignable to Prisma's Json input type.
export type Svg = {
  name: string;
  dataUri: string;
};

// Result of an "ab" run (single component, two variants).
export interface AbResult {
  winner: "A" | "B";
  confidence: number;
  scoreA: number;
  scoreB: number;
  reportMarkdown: string;
  svgs: Svg[];
}

// Result of a "full" run (whole-store customer-experience audit).
export interface FullResult {
  mode: "full";
  storeScore: number;
  summaryMarkdown: string;
  products: {
    title: string;
    score: number;
    topObjections: string[];
    issues: string[];
    highlight: string;
  }[];
  reviews: { persona: string; rating: number; text: string }[];
  svgs: Svg[];
}

export type RunResult = AbResult | FullResult;

export function isFullResult(r: RunResult): r is FullResult {
  return (r as FullResult).mode === "full";
}

// Shared secret sent to the backend (must match its BACKEND_SECRET). Lets the
// backend stay private/unauthenticated-to-the-world while only the app can call it.
const SECRET = process.env.BACKEND_SECRET || "";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(SECRET ? { "X-ShopSim-Auth": SECRET } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`backend ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export function startRun(
  payload: RunPayload,
): Promise<{ jobId: string; status: string }> {
  return call("/run", { method: "POST", body: JSON.stringify(payload) });
}

export async function getStatus(
  jobId: string,
): Promise<{ status: "running" | "completed" | "failed"; error?: string }> {
  const res = await fetch(`${BASE}/status/${jobId}`, {
    headers: { ...(SECRET ? { "X-ShopSim-Auth": SECRET } : {}) },
  });
  // The in-memory job is gone (backend restarted mid-run, or job never existed).
  // Treat as failed so the experiment stops polling instead of 404-looping forever.
  if (res.status === 404) {
    return {
      status: "failed",
      error:
        "The simulation was lost (the backend restarted mid-run). Re-run the experiment, " +
        "and avoid changing backend settings while a run is in progress.",
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`backend /status/${jobId} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as {
    status: "running" | "completed" | "failed";
    error?: string;
  };
}

export function getResult(jobId: string): Promise<RunResult> {
  return call(`/result/${jobId}`);
}

// Variant generation runs on the backend so the frontend holds no LLM keys.
export function suggestVariant(
  type: ComponentType,
  title: string,
  baseline: Record<string, string>,
): Promise<{ suggestion: Record<string, string> }> {
  return call("/suggest", {
    method: "POST",
    body: JSON.stringify({ componentType: type, title, baseline }),
  });
}
