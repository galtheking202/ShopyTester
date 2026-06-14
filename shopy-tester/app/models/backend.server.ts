// HTTP client for the ShopSim backend service (MiroFish + variant generation).
// In production this points at the Railway container; locally at the worker.

import type { ComponentType } from "./types";

const BASE =
  process.env.BACKEND_URL ||
  process.env.MIROFISH_WORKER_URL ||
  "http://localhost:8800";

export interface RunPayload {
  shopContext: string;
  variantA: string;
  variantB: string;
  requirement: string;
  componentType: string;
}

export interface MirofishResult {
  winner: "A" | "B";
  confidence: number;
  scoreA: number;
  scoreB: number;
  reportMarkdown: string;
  svgs: { name: string; dataUri: string }[];
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

export function getStatus(
  jobId: string,
): Promise<{ status: "running" | "completed" | "failed"; error?: string }> {
  return call(`/status/${jobId}`);
}

export function getResult(jobId: string): Promise<MirofishResult> {
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
