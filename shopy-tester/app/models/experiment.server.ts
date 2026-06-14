import prisma from "../db.server";
import type { ComponentType } from "./types";
import { buildShopContext, renderComponentMarkdown } from "./serialize.server";
import { getResult, getStatus, startRun } from "./backend.server";

interface CreateArgs {
  shop: string;
  snapshotId: string;
  componentId: string;
  name: string;
  variantA: Record<string, string>;
  variantB: Record<string, string>;
}

// Build seed material from the snapshot, launch a MiroFish run, and persist the
// experiment with its two variants.
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

  const requirement =
    `Predict which variant of the ${type.replace("_", " ")} "${component.title}" ` +
    `drives more conversions and purchase intent for this store's shoppers.`;

  const { jobId } = await startRun({
    shopContext,
    variantA: variantAMd,
    variantB: variantBMd,
    requirement,
    componentType: type,
  });

  return prisma.experiment.create({
    data: {
      shop: args.shop,
      snapshotId: args.snapshotId,
      componentId: args.componentId,
      componentType: type,
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
    return prisma.experiment.update({
      where: { id: exp.id },
      data: {
        status: "completed",
        winner: result.winner,
        confidence: result.confidence,
        scoreA: result.scoreA,
        scoreB: result.scoreB,
        reportMarkdown: result.reportMarkdown,
        svgs: result.svgs,
      },
      include: { variants: true },
    });
  } catch (err) {
    // Backend unreachable — leave it running so the next poll can retry.
    console.error("refreshExperiment", err);
    return exp;
  }
}
