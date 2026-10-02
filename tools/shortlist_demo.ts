#!/usr/bin/env node
/**
 * Shortlist demo — TS twin of the repo's `test.py` (which is NOT a test despite
 * the name: it is a hand-run demo of laya's `predict_shortlist` on a large label
 * set, where the k-window keeps the prompt inside the model's context).
 *
 *   node --experimental-strip-types tools/shortlist_demo.ts
 *
 * Needs the ONNX artifact + the HF tokenizer cache (see src/laya-onnx.ts); the
 * demo says so instead of failing with a stack trace when they are missing.
 */
import fs from "node:fs";
import {
  DEFAULT_ONNX_PATH, createLayaOnnxRuntime, findDefaultTokenizerDir,
} from "../src/laya-onnx.ts";
import { installLayaRuntime, type Question } from "../src/model.ts";

const questions: Record<string, Question> = {
  intent: {
    type: "choice",
    instructions: "Which banking intent is this?",
    criteria: {
      card_arrival: "where is my card",
      transfer_fee: "fee charged on a transfer",
      lost_card: "I lost my card and need a replacement",
      statement: "download a monthly statement",
      branch_hours: "when is the nearest branch open",
      fraud_report: "report an unauthorized transaction",
      limit_increase: "raise my daily spending limit",
      pin_reset: "reset my card PIN",
      balance: "what is my current balance",
      international: "using my card abroad",
      // ...the rest of a large label set
    },
  },
};

async function main(): Promise<number> {
  if (!fs.existsSync(DEFAULT_ONNX_PATH) || !findDefaultTokenizerDir()) {
    console.log("shortlist demo needs the ONNX artifact and the tokenizer cache:");
    console.log(`  model:     ${DEFAULT_ONNX_PATH} (export it; see node-port-poc/README.md)`);
    console.log("  tokenizer: HF cache snapshots/*/tokenizer/");
    return 2;
  }
  installLayaRuntime(createLayaOnnxRuntime());
  const runtime = createLayaOnnxRuntime();
  const agent = await runtime.load("convaiinnovations/laya");
  const res = await runtime.predictShortlist(
    agent, { text: "I was charged twice for a transfer" }, questions,
    { embedFn: runtime.embedFnFromAgent(agent), k: 20 });
  const answer = res.answers.intent as { choice: string; confidence: number };
  console.log("答案        :", JSON.stringify(answer));
  console.log("候选标签    :", JSON.stringify(res.shortlist?.intent?.kept ?? []));
  console.log("passthrough :", JSON.stringify(res.shortlist?.intent?.passthrough ?? null));
  return 0;
}

process.exit(await main());
