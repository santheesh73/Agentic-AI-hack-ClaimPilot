// Drives lib/models.ts generate() with a mocked provider model for each failure mode.
import { it, vi } from "vitest";
import fs from "node:fs";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { makeClient, type Db } from "./auditFakeDb";

let db: Db = { agent_events: [] } as Db;
let behaviour: () => Promise<any>;
let doGenerateCalls = 0;
vi.mock("@/lib/db", () => ({ supabaseAdmin: () => makeClient(db) }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => () => new MockLanguageModelV4({ doGenerate: async () => { doGenerateCalls++; return behaviour(); } }) }));

const ok = (text: string) => async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] });
const httpErr = (status: number) => async () => { throw new APICallError({ message: `HTTP ${status}`, url: "https://x", requestBodyValues: {}, statusCode: status, isRetryable: status === 429 || status >= 500 }); };

it("generate() behaviour per failure mode", async () => {
  const { generate } = await import("@/lib/models");
  const schema = z.object({ verdict: z.enum(["A", "B"]), n: z.number() });
  const modes: Array<[string, () => Promise<any>]> = [
    ["valid", ok('{"verdict":"A","n":1}')],
    ["extra fields", ok('{"verdict":"A","n":1,"injected":"x"}')],
    ["malformed (not JSON)", ok("Sure! Here is the answer: A")],
    ["partial JSON", ok('{"verdict":"A",')],
    ["wrong enum", ok('{"verdict":"C","n":1}')],
    ["timeout/abort", async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }],
    ["HTTP 429", httpErr(429)],
    ["HTTP 503", httpErr(503)],
    ["HTTP 401", httpErr(401)],
  ];
  const rows = [];
  for (const [name, b] of modes) {
    behaviour = b; doGenerateCalls = 0; db = { agent_events: [] } as Db;
    const t0 = Date.now(); let result: string;
    try { const r = await generate({ caseId: "c", step: "S", tool: "t", model: "m", schema, system: "s", prompt: "p" }); result = "returned " + JSON.stringify(r); }
    catch (e) { result = `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 80)}`; }
    rows.push({ mode: name, provider_calls: doGenerateCalls, failure_events_logged: db.agent_events.filter((e) => e.output == null).length, logged_status: db.agent_events.map((e) => (e.summary ?? "").match(/status=([^)]*)/)?.[1]).filter(Boolean), ms: Date.now() - t0, result });
  }
  fs.writeFileSync("audit/logs/30-llm-failures.json", JSON.stringify(rows, null, 2));
}, 240_000);
