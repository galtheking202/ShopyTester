import prisma from "../db.server";
import type { IngestedComponent } from "./types";

// Persist a freshly ingested store as a new immutable snapshot.
export async function saveSnapshot(
  shop: string,
  components: IngestedComponent[],
) {
  return prisma.shopSnapshot.create({
    data: {
      shop,
      components: {
        create: components.map((c) => ({
          type: c.type,
          externalId: c.externalId,
          handle: c.handle,
          title: c.title,
          data: c.data as object,
          markdown: c.markdown,
        })),
      },
    },
    include: { components: true },
  });
}

export async function getLatestSnapshot(shop: string) {
  return prisma.shopSnapshot.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: { components: true },
  });
}
