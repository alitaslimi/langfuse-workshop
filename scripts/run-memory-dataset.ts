import "../src/server/load-env";

// Profile-memory experiment: runs the agent with memory ON against the
// memory dataset and scores whether it saved exactly the expected facts.
//
// Memory is kept in RAM and reset before every item, so items are
// independent and Dad's saved profile (.data/support-profile.json) is never
// read or written.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { randomUUID } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import type { ChatMessage, ProfileField, ProfileUpdate } from "../src/shared/types";
import { env } from "../src/server/env";
import { enableSupportMemory, resetSupportProfile } from "../src/server/support-profile";
import { runSupportConversation } from "../src/server/support-agent";

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

enableSupportMemory({ persist: false });

type DatasetInput = { messages: Array<{ role: ChatMessage["role"]; content: string }> };
type ExpectedUpdate = { field: ProfileField; value: string };
type DatasetExpectation = { expectedUpdates: ExpectedUpdate[] };
type TaskOutput = { answer: string; savedUpdates: ExpectedUpdate[] };

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// "iPhone 17" matches "iPhone 17" and "an iPhone 17"; fields must be equal.
function sameUpdate(saved: ExpectedUpdate, expected: ExpectedUpdate) {
  if (saved.field !== expected.field) return false;
  const a = normalize(saved.value);
  const b = normalize(expected.value);
  return a === b || a.includes(b) || b.includes(a);
}

function toRuntimeMessages(input: DatasetInput) {
  return input.messages.map((message, index) => ({
    id: `dataset-message-${index + 1}`,
    role: message.role,
    content: message.content,
    timestamp: new Date().toISOString()
  }));
}

function describe(updates: ExpectedUpdate[]) {
  return updates.length ? updates.map((update) => `${update.field}=${update.value}`).join(", ") : "nothing";
}

async function main() {
  if (!env.langfusePublicKey || !env.langfuseSecretKey || !env.openaiApiKey) {
    throw new Error("Langfuse credentials and OPENAI_API_KEY are required.");
  }

  const langfuse = new LangfuseClient({
    publicKey: env.langfusePublicKey,
    secretKey: env.langfuseSecretKey,
    baseUrl: env.langfuseBaseUrl
  });

  const dataset = await langfuse.dataset.get(env.memoryDatasetName);
  const runName = `dad-memory-${new Date().toISOString()}`;

  const result = await dataset.runExperiment({
    name: "Dad profile memory experiment",
    runName,
    description: "Checks which facts update_support_context saves",
    metadata: { model: env.openaiModel },
    // Items share the in-memory profile, so they must run one at a time.
    maxConcurrency: 1,
    task: async (item): Promise<TaskOutput> => {
      resetSupportProfile();
      const response = await runSupportConversation({
        sessionId: `dataset-memory-${randomUUID()}`,
        userId: "dataset-runner",
        messages: toRuntimeMessages(item.input as DatasetInput)
      });
      const savedUpdates = response.profileUpdates
        .filter((update: ProfileUpdate) => update.source === "chat")
        .map((update) => ({ field: update.field, value: update.value ?? "" }));
      return { answer: response.answer, savedUpdates };
    },
    evaluators: [
      // 1 when the saved facts are exactly the expected ones (none expected
      // means nothing may be saved), otherwise 0.
      async ({ output, expectedOutput }) => {
        const { savedUpdates } = output as TaskOutput;
        const { expectedUpdates } = expectedOutput as DatasetExpectation;
        const missing = expectedUpdates.filter((expected) => !savedUpdates.some((saved) => sameUpdate(saved, expected)));
        const unexpected = savedUpdates.filter((saved) => !expectedUpdates.some((expected) => sameUpdate(saved, expected)));
        const correct = missing.length === 0 && unexpected.length === 0;
        return {
          name: "memory_correct",
          value: correct ? 1 : 0,
          comment: correct
            ? `Saved ${describe(savedUpdates)}, as expected.`
            : `Expected ${describe(expectedUpdates)}; saved ${describe(savedUpdates)}.`
        };
      },
      // Facts saved that Dad never stated: the costly mistake for a memory.
      async ({ output, expectedOutput }) => {
        const { savedUpdates } = output as TaskOutput;
        const { expectedUpdates } = expectedOutput as DatasetExpectation;
        const unexpected = savedUpdates.filter((saved) => !expectedUpdates.some((expected) => sameUpdate(saved, expected)));
        return {
          name: "memory_false_saves",
          value: unexpected.length,
          comment: unexpected.length ? `Unexpected: ${describe(unexpected)}.` : "No unexpected saves."
        };
      }
    ]
  });

  console.log(await result.format());
  await langfuse.flush();
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
}

void main();
