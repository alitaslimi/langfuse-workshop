import "./load-env";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChatRequest } from "../shared/types";
import { getDataResponse, isDataRange } from "./analytics";
import { getInsightsResponse } from "./insights";
import { getQualityResponse } from "./quality";
import { runSupportConversation } from "./support-agent";
import { env, isLangfuseConfigured } from "./env";
import { enableSupportMemory, getSupportContext, getSupportProfile, resetSupportProfile } from "./support-profile";

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

// The web app remembers what Dad tells it (see support-profile.ts).
enableSupportMemory();

const requestSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().optional(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.union([z.literal("user"), z.literal("assistant")]),
        content: z.string().min(1),
        timestamp: z.string()
      })
    )
    .min(1)
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    provider: "openai",
    tracingConfigured: isLangfuseConfigured()
  });
});

app.get("/api/support-context", (_request, response) => {
  response.json(getSupportContext());
});

app.get("/api/support-profile", (_request, response) => {
  response.json(getSupportProfile());
});

app.post("/api/support-profile/reset", (_request, response) => {
  resetSupportProfile();
  response.json(getSupportProfile());
});

app.get("/api/data", async (request, response) => {
  if (!isLangfuseConfigured()) {
    response.status(503).send("Langfuse keys are not configured in .env, so there is no data to read.");
    return;
  }
  const range = isDataRange(request.query.range) ? request.query.range : "7d";
  try {
    response.json(await getDataResponse(range, request.query.refresh === "1"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response.status(502).send(`Could not read data from Langfuse: ${message}`);
  }
});

app.get("/api/quality", async (request, response) => {
  if (!isLangfuseConfigured()) {
    response.status(503).send("Langfuse keys are not configured in .env.");
    return;
  }
  const range = isDataRange(request.query.range) ? request.query.range : "7d";
  try {
    response.json(await getQualityResponse(range, request.query.refresh === "1"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response.status(502).send(`Could not read the quality loop from Langfuse: ${message}`);
  }
});

app.get("/api/insights", async (request, response) => {
  if (!isLangfuseConfigured() || !env.openaiApiKey) {
    response.status(503).send("Request insights need both Langfuse keys and an OpenAI key in .env.");
    return;
  }
  const range = isDataRange(request.query.range) ? request.query.range : "7d";
  try {
    response.json(await getInsightsResponse(range, request.query.refresh === "1"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    response.status(502).send(`Could not build request insights: ${message}`);
  }
});

app.post("/api/chat", async (request, response) => {
  try {
    const payload = requestSchema.parse(request.body) as ChatRequest;
    const result = await runSupportConversation(payload);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    response.status(400).send(message);
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(currentDir, "../../dist");

app.use(express.static(clientDist));
app.use((_request, response) => {
  response.sendFile(path.join(clientDist, "index.html"));
});

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`Dad IT Support Agent server listening on http://127.0.0.1:${env.port}`);
});

async function shutdown() {
  server.close();
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
