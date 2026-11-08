// Оценка набора организаторов (FBroker) по официальному чек-листу без интерфейса.
// Запуск: node --env-file-if-exists=.env --experimental-strip-types scripts/run-prod.ts <input.json> <output.json>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseImport } from "../src/lib/cqa/engine.ts";
import { officialCriteria, OFFICIAL_VERSION_ID } from "../src/lib/cqa/seed.ts";
import { runEvaluation } from "../src/lib/cqa/evaluate-run.ts";
import { resolveLlmConfig, fetchComplete } from "../src/lib/cqa/ai-fns.ts";
import { PROMPT_VERSION } from "../src/lib/cqa/types.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: run-prod.ts <input.json> <output.json>");

const parsed = parseImport(JSON.parse(readFileSync(input, "utf8")), "FBroker", "organizer");
if (parsed.error) console.error("import note:", parsed.error);
const config = resolveLlmConfig(process.env);
if (!config.apiKey && !config.isLocal) throw new Error("нет ключа модели");

const results: unknown[] = [];
let cost = 0;
await Promise.all(
  [0, 1, 2, 3].map(async (worker) => {
    for (let i = worker; i < parsed.conversations.length; i += 4) {
      const conversation = parsed.conversations[i]!;
      const started = Date.now();
      const res = await runEvaluation(
        { conversation, criteria: officialCriteria, model: config.model },
        {
          complete: (mdl, maxTokens, messages) =>
            fetchComplete(config.apiKey, config.baseUrl, mdl, maxTokens, messages, config.timeoutMs, config.reasoningEffort, config.priceInputPerM, config.priceOutputPerM),
          env: process.env,
          isLocal: config.isLocal,
          priceInputPerM: config.priceInputPerM,
          priceOutputPerM: config.priceOutputPerM,
        },
      );
      const usage = (res as { usage?: { estimatedCostUsd?: number } }).usage;
      cost += usage?.estimatedCostUsd ?? 0;
      console.log(conversation.externalId, res.ok ? `${res.status} ${res.total}` : `ERROR ${res.error}`, `${Math.round((Date.now() - started) / 1000)}s`);
      results[i] = { conversation_id: conversation.externalId, language: conversation.language, channel: conversation.channel, model: config.model, prompt_version: PROMPT_VERSION, checklist_version: OFFICIAL_VERSION_ID, response: res };
    }
  }),
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(results, null, 2));
console.log(`done ${results.length}, cost ~$${cost.toFixed(4)}`);
