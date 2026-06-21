import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { ComponentType } from "./types";
import {
  buildAudienceBrief,
  buildShopContext,
  renderComponentMarkdown,
} from "./serialize.server";
import { getResult, getStatus, isFullResult, startRun } from "./backend.server";

interface CreateArgs {
  shop: string;
  snapshotId: string;
  componentId: string;
  name: string;
  variantA: Record<string, string>;
  variantB: Record<string, string>;
}

// Build seed material from the snapshot, launch a backend "ab" run, and persist
// the experiment with its two variants.
export async function createAndLaunchExperiment(args: CreateArgs) {
  const component = await prisma.component.findUniqueOrThrow({
    where: { id: args.componentId },
  });
  const all = await prisma.component.findMany({
    where: { snapshotId: args.snapshotId },
  });

  const type = component.type as ComponentType;
  const data = (component.data ?? {}) as Record<string, unknown>;

  const shopContext = buildShopContext(
    args.shop,
    all.map((c) => ({
      type: c.type as ComponentType,
      title: c.title,
      markdown: c.markdown,
    })),
  );
  const variantAMd = renderComponentMarkdown(
    type,
    component.title,
    data,
    args.variantA,
  );
  const variantBMd = renderComponentMarkdown(
    type,
    component.title,
    data,
    args.variantB,
  );

  const audienceBrief = buildAudienceBrief(
    all.map((c) => ({ type: c.type, title: c.title, data: c.data })),
  );

  const store = audienceBrief.brandName || "this store";
  const requirement =
    `You are a prospective shopper for ${store}. After seeing the ` +
    `${type.replace("_", " ")} "${component.title}", decide whether you would buy, ` +
    `weighing price vs. value, trust, fit with your needs, and any objections. ` +
    `We are comparing two variants to see which drives more purchase intent.`;

  const { jobId } = await startRun({
    shopContext,
    mode: "ab",
    variantA: variantAMd,
    variantB: variantBMd,
    requirement,
    componentType: type,
    audienceBrief,
  });

  return prisma.experiment.create({
    data: {
      shop: args.shop,
      snapshotId: args.snapshotId,
      componentId: args.componentId,
      componentType: type,
      mode: "ab",
      name: args.name,
      requirement,
      status: "running",
      jobId,
      variants: {
        create: [
          {
            label: "A",
            isBaseline: true,
            data: args.variantA,
            markdown: variantAMd,
          },
          {
            label: "B",
            isBaseline: false,
            data: args.variantB,
            markdown: variantBMd,
          },
        ],
      },
    },
  });
}

interface FullArgs {
  shop: string;
  snapshotId: string;
  name: string;
}

// Launch a whole-store customer-experience audit (no component, no variants).
export async function createAndLaunchFullTest(args: FullArgs) {
  const all = await prisma.component.findMany({
    where: { snapshotId: args.snapshotId },
  });

  const shopContext = buildShopContext(
    args.shop,
    all.map((c) => ({
      type: c.type as ComponentType,
      title: c.title,
      markdown: c.markdown,
    })),
  );
  const audienceBrief = buildAudienceBrief(
    all.map((c) => ({ type: c.type, title: c.title, data: c.data })),
  );

  const store = audienceBrief.brandName || "this store";
  const requirement =
    `Simulate realistic prospective shoppers experiencing ${store} end to end: ` +
    `browsing products, weighing price vs. value and trust, and deciding whether to buy. ` +
    `Audit the whole-store shopping experience.`;

  const { jobId } = await startRun({
    shopContext,
    mode: "full",
    requirement,
    componentType: "store",
    audienceBrief,
  });

  return prisma.experiment.create({
    data: {
      shop: args.shop,
      snapshotId: args.snapshotId,
      mode: "full",
      name: args.name,
      requirement,
      status: "running",
      jobId,
    },
  });
}

// Poll the backend for a running experiment and fold the result into the DB.
export async function refreshExperiment(experimentId: string) {
  const exp = await prisma.experiment.findUniqueOrThrow({
    where: { id: experimentId },
    include: { variants: true },
  });
  if (exp.status !== "running" || !exp.jobId) return exp;

  try {
    const status = await getStatus(exp.jobId);
    if (status.status === "running") return exp;

    if (status.status === "failed") {
      return prisma.experiment.update({
        where: { id: exp.id },
        data: { status: "failed", error: status.error ?? "Simulation failed" },
        include: { variants: true },
      });
    }

    const result = await getResult(exp.jobId);
    const data = isFullResult(result)
      ? {
          status: "completed",
          storeScore: result.storeScore,
          fullResult: {
            summaryMarkdown: result.summaryMarkdown,
            products: result.products,
            reviews: result.reviews,
            svgs: result.svgs,
          } satisfies Prisma.InputJsonValue,
        }
      : {
          status: "completed",
          winner: result.winner,
          confidence: result.confidence,
          scoreA: result.scoreA,
          scoreB: result.scoreB,
          reportMarkdown: result.reportMarkdown,
          svgs: result.svgs,
        };
    return prisma.experiment.update({
      where: { id: exp.id },
      data,
      include: { variants: true },
    });
  } catch (err) {
    // Backend unreachable — leave it running so the next poll can retry.
    console.error("refreshExperiment", err);
    return exp;
  }
}
