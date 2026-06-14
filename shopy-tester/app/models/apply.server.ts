import type { ComponentType } from "./types";

type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

// Convert the plain-text we A/B tested back into simple storefront HTML.
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>").trim()}</p>`)
    .filter((p) => p !== "<p></p>")
    .join("");
}

async function mutate(
  graphql: GraphqlClient,
  query: string,
  variables: Record<string, unknown>,
  userErrorsPath: string,
) {
  const res = await graphql(query, { variables });
  const json = (await res.json()) as any;
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const errs = userErrorsPath.split(".").reduce((o, k) => o?.[k], json.data);
  if (Array.isArray(errs) && errs.length) {
    throw new Error(errs.map((e: any) => e.message).join("; "));
  }
}

// Write a winning variant back to the store. Only product/collection/page
// support automatic write-back; other types must be applied manually.
export async function applyWinner(
  graphql: GraphqlClient,
  componentType: ComponentType,
  externalId: string,
  data: Record<string, string>,
) {
  switch (componentType) {
    case "product":
      await mutate(
        graphql,
        `#graphql
          mutation ProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        {
          input: {
            id: externalId,
            ...(data.title ? { title: data.title } : {}),
            ...(data.description
              ? { descriptionHtml: textToHtml(data.description) }
              : {}),
          },
        },
        "productUpdate.userErrors",
      );
      return;

    case "collection":
      await mutate(
        graphql,
        `#graphql
          mutation CollectionUpdate($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        {
          input: {
            id: externalId,
            ...(data.title ? { title: data.title } : {}),
            ...(data.description
              ? { descriptionHtml: textToHtml(data.description) }
              : {}),
          },
        },
        "collectionUpdate.userErrors",
      );
      return;

    case "page":
      await mutate(
        graphql,
        `#graphql
          mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
            pageUpdate(id: $id, page: $page) {
              userErrors { field message }
            }
          }`,
        {
          id: externalId,
          page: {
            ...(data.title ? { title: data.title } : {}),
            ...(data.description ? { body: textToHtml(data.description) } : {}),
          },
        },
        "pageUpdate.userErrors",
      );
      return;

    default:
      throw new Error(
        `Automatic apply is not supported for "${componentType}". Update it manually in your admin.`,
      );
  }
}
