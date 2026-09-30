import "../src/server/load-env";

// Backfill Dad's profile from chats that happened before profile memory
// existed. Reads past live chat turns from Langfuse, asks the model whether
// Dad's message states a lasting fact (using the agent's own
// update_support_context tool definition, so the rules are identical), and
// applies it through the same evidence check as live chat.
//
// Dry run by default: prints what would be saved and writes nothing.
//   npm run profile:backfill                 # dry run, last 30 days
//   npm run profile:backfill -- --apply      # save to .data/support-profile.json
//   npm run profile:backfill -- --days 90 --include-seed
//
// Turns that already called update_support_context live are skipped, and
// seeded sample traffic (userId "seed-…") is skipped unless --include-seed.
import OpenAI from "openai";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { observeOpenAI } from "@langfuse/openai";
import { propagateAttributes } from "@langfuse/tracing";
import { TURN_OBSERVATION_NAME, isLiveTraffic, listObservations, readTurnMessages } from "../src/server/analytics";
import { env } from "../src/server/env";
import { applyProfileChanges, enableSupportMemory, getSupportContext } from "../src/server/support-profile";
import { UPDATE_SUPPORT_CONTEXT_TOOL, parseChanges } from "../src/server/tools";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeSeed = args.includes("--include-seed");
const daysIndex = args.indexOf("--days");
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 30;

const langfuseSpanProcessor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

const EXTRACT_PROMPT = `You are reviewing one message Dad sent to his iPhone help assistant in the past.
If the message clearly states a lasting fact about Dad's own phone or setup, call update_support_context with Dad's exact words as evidence.
Otherwise reply with the single word: none.
The profile as it is known right now:
`;

async function main() {
  if (!env.langfusePublicKey || !env.langfuseSecretKey || !env.openaiApiKey) {
    throw new Error("Langfuse credentials and OPENAI_API_KEY are required.");
  }
  // Start from the saved profile; only --apply writes back to it.
  enableSupportMemory({ persist: apply, loadFromStore: true });

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const [turns, liveUpdates] = await Promise.all([
    listObservations({ type: "AGENT", name: TURN_OBSERVATION_NAME }, "core,basic,io", from.toISOString(), to.toISOString(), 5000),
    listObservations({ type: "TOOL", name: "update_support_context" }, "core", from.toISOString(), to.toISOString(), 5000)
  ]);
  const alreadyHandled = new Set(liveUpdates.items.map((item) => item.traceId));

  const candidates = turns.items
    .filter(isLiveTraffic)
    .filter((turn) => includeSeed || !String(turn.userId ?? "").startsWith("seed-"))
    .filter((turn) => !alreadyHandled.has(turn.traceId))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  console.log(
    `${apply ? "APPLY" : "DRY RUN"}: checking ${candidates.length} past turns from the last ${days} days ` +
      `(${alreadyHandled.size} already handled live${includeSeed ? "" : ", seeded traffic skipped"}).\n`
  );

  let saved = 0;
  await propagateAttributes({ traceName: "profile-backfill", tags: ["profile-backfill"] }, async () => {
    const openai = observeOpenAI(new OpenAI({ apiKey: env.openaiApiKey }), { generationName: "profile-backfill" });
    for (const turn of candidates) {
      const message = readTurnMessages(turn.input).filter((entry) => entry.role === "user").at(-1)?.content ?? "";
      if (!message.trim()) continue;
      const completion = await openai.chat.completions.create({
        model: env.openaiModel,
        messages: [
          { role: "system", content: EXTRACT_PROMPT + JSON.stringify(getSupportContext().phone) },
          { role: "user", content: message }
        ],
        tools: [UPDATE_SUPPORT_CONTEXT_TOOL],
        tool_choice: "auto"
      });
      const call = completion.choices[0]?.message?.tool_calls?.find(
        (entry) => entry.type === "function" && entry.function.name === "update_support_context"
      );
      if (!call || call.type !== "function") continue;

      let parsed: { changes?: unknown; evidence?: unknown } = {};
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch {
        continue;
      }
      const changes = parseChanges(parsed.changes);
      if (!changes) continue;
      const result = applyProfileChanges(changes, {
        evidence: String(parsed.evidence ?? ""),
        userMessages: [message],
        sessionId: turn.sessionId ?? null,
        traceId: turn.traceId
      });
      const when = new Date(turn.startTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      if (!result.ok) {
        console.log(`  ${when}  “${message}”\n    rejected: ${result.error}`);
        continue;
      }
      for (const update of result.applied) {
        saved += 1;
        console.log(
          `  ${when}  “${message}”\n    ${apply ? "saved" : "would save"}: ${update.field} ${update.previousValue ?? "—"} → ${update.value ?? "not known"}${
            update.source === "cleared" ? " (cleared: old phone detail)" : ""
          }`
        );
      }
      for (const skip of result.skipped) console.log(`  ${when}  “${message}”\n    skipped ${skip.field}: ${skip.reason}`);
    }
  });

  console.log(
    `\n${saved} change${saved === 1 ? "" : "s"} ${apply ? "saved" : "found"}.${
      !apply && saved > 0 ? " Re-run with --apply to save them." : ""
    }`
  );
  await langfuseSpanProcessor.forceFlush();
  await sdk.shutdown();
}

void main();
