#!/usr/bin/env node
/**
 * Thin entry for the plan CLI (mirrors `python plan_cli.py`):
 *   npm run plan-cli -- new "goal" --url https://…
 */
import { main } from "../src/cli/plan-cli.ts";

process.exit(await main());
