// app/routes/app.metafielddefinition.jsx
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const metafieldDefinitions = [
    {
      name: "Company Email",
      namespace: "custom",
      key: "companyEmail",
      description:
        "Email address associated with the company (enforced unique by app)",
      type: "single_line_text_field",
      ownerType: "COMPANY",
      capabilities: {
        uniqueValues: { enabled: true },
      },
    },
  ];

  try {
    for (const definition of metafieldDefinitions) {
      // Check existing definitions for this ownerType
      const checkResponse = await admin.graphql(
        `
        query GetMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
          metafieldDefinitions(first: 100, ownerType: $ownerType) {
            edges {
              node {
                id
                name
                namespace
                key
              }
            }
          }
        }
      `,
        { variables: { ownerType: definition.ownerType } }
      );

      const checkData = await checkResponse.json();
      const existing = checkData.data?.metafieldDefinitions?.edges?.find(
        (e) =>
          e.node.namespace === definition.namespace && e.node.key === definition.key
      );

      if (!existing) {
        const createResp = await admin.graphql(
          `
          mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition {
                id
                name
                namespace
                key
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          { variables: { definition } }
        );

        const createJson = await createResp.json();
        const errs =
          createJson.data?.metafieldDefinitionCreate?.userErrors || [];
        if (errs.length) {
          console.error(
            `Error creating ${definition.namespace}.${definition.key}:`,
            errs
          );
        } else {
          console.log(
            `Created metafield definition: ${definition.namespace}.${definition.key}`
          );
        }
      }
    }
  } catch (err) {
    console.error("Error ensuring metafield definitions:", err);
  }

  // Route returns a small payload so your fetcher doesn’t choke
  return { ok: true };
};
