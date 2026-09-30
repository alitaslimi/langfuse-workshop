import "../src/server/load-env";
import { LangfuseClient } from "@langfuse/client";
import seedMemoryDataset from "../data/seed-memory-dataset.json";
import { env } from "../src/server/env";

// Seeds the profile-memory dataset: each item is a message from Dad plus the
// profile updates the agent should (or should not) save through
// update_support_context. Items are upserted by id, so re-running is safe.

async function main() {
  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    throw new Error("Langfuse credentials are required to seed a dataset.");
  }

  const langfuse = new LangfuseClient({
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl
  });

  try {
    await langfuse.api.datasets.create({
      name: env.memoryDatasetName,
      description: "Does the agent save the right facts about Dad's phone, and only those?",
      metadata: { source: "repo-seed", feature: "profile-memory" }
    });
  } catch (error) {
    if (!(error instanceof Error) || !/exists|duplicate/i.test(error.message)) {
      throw error;
    }
  }

  for (const item of seedMemoryDataset) {
    await langfuse.api.datasetItems.create({
      id: item.id,
      datasetName: env.memoryDatasetName,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata
    });
  }

  await langfuse.flush();
  console.log(`Seeded dataset "${env.memoryDatasetName}" with ${seedMemoryDataset.length} items.`);
}

void main();
