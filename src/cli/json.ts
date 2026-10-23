import type { CliError } from "./errors.ts";

export const SCHEMA_VERSION = 1;

export interface JsonEnvelope<T = unknown> {
  schema_version: number;
  command: string;
  ok: boolean;
  exit_code: number;
  data?: T;
  error?: { code: string; message: string; hint?: string; next: string[] };
  diagnostics: string[];
  next: string[];
}

export function successEnvelope<T>(
  command: string,
  data: T,
  opts: { exitCode?: number; diagnostics?: string[]; next?: string[] } = {},
): JsonEnvelope<T> {
  const exitCode = opts.exitCode ?? 0;
  return {
    schema_version: SCHEMA_VERSION,
    command,
    ok: exitCode === 0,
    exit_code: exitCode,
    data,
    diagnostics: opts.diagnostics ?? [],
    next: opts.next ?? [],
  };
}

export function errorEnvelope(
  command: string,
  err: CliError,
  diagnostics: string[] = [],
): JsonEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    ok: false,
    exit_code: err.exitCode,
    error: {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      next: err.next,
    },
    diagnostics,
    next: err.next,
  };
}
