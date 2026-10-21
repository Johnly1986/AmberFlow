/**
 * Path B in TypeScript — the TS twin of `picker_server.py`.
 *
 * The Python service is FastAPI + uvicorn:
 *
 *   GET  /health -> {"status": "ok", "device": str(picker.agent.device)}
 *   POST /pick   -> PickRequest {state, confidence_threshold?, attack_threshold?}
 *                   -> picker.pick(state) (the whole decision dict)
 *
 * The extension in `extension/` is the only client. `background.js` POSTs
 * `JSON.stringify({ state: msg.state })` to `http://127.0.0.1:8765/pick` and
 * `content.js` reads `decision.auto_execute` / `decision.selector` /
 * `decision.reason` / `decision.candidates[].{label,probability,selector}` — so
 * the response is passed through verbatim, never re-shaped here.
 *
 * This port uses `node:http` (no express/fastify) and mirrors the pydantic v2
 * failure semantics: validation errors are 422 with
 * `{"detail": [{type, loc, msg, input, ctx?}]}`, unknown routes are 404 with
 * `{"detail": "Not Found"}`, wrong methods are 405 with a JSON detail + Allow.
 *
 * Deliberate deviations from FastAPI (all documented, none observable by the
 * extension):
 *   - the picker is loaded LAZILY on the first request instead of at startup
 *     (nothing imports onnxruntime at module load); `/health` therefore also
 *     loads it, exactly when the model's device string first becomes available;
 *   - a trailing slash is normalised (`/pick/` -> `/pick`) instead of FastAPI's
 *     307 redirect;
 *   - request bodies above 1 MiB are rejected with 413 (FastAPI has no cap);
 *   - an unhandled picker error is 500 `{"detail": "Internal Server Error"}`
 *     (Starlette returns plain text there).
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { QuickActionPicker, type PickDecision } from "../engine/picker.ts";
import { applyRcToEnv } from "../support/rcfile.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOST = "127.0.0.1";
/** Same default port as the Python service / `extension/background.js`. */
export const DEFAULT_PORT = 8765;
/** Defensive body cap; see the deviations note above. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The slice of `QuickActionPicker` this server uses. `agent` stays `unknown`
 * (as in the class) so a fake picker can be injected without a checkpoint.
 */
export interface PickerLike {
  agent?: unknown;
  conf_threshold?: number;
  attack_threshold?: number;
  pick(state: Record<string, unknown>): PickDecision | Promise<PickDecision>;
}

export type PickerFactory = () => Promise<PickerLike>;

export interface PickerServerOptions {
  /** Injected picker (test seam). When absent the default is loaded lazily. */
  picker?: PickerLike;
  host?: string;
  port?: number;
  /** Lazy factory for the default picker; overridable for tests. */
  loadPicker?: PickerFactory;
  log?: (line: string) => void;
}

export interface PickerServerHandle {
  server: Server;
  host: string;
  /** Requested port before `start()`; the bound port afterwards. */
  port: number;
  url: string;
  start(): Promise<PickerServerHandle>;
  /** Idempotent: the second call returns the first call's promise. */
  close(): Promise<void>;
}

/** `QuickActionPicker.load()` without importing the runtime at module scope. */
export const defaultPickerFactory: PickerFactory = () => QuickActionPicker.load();

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deviceOf(picker: PickerLike): string {
  const agent = picker.agent;
  if (agent !== null && typeof agent === "object" && "device" in agent) {
    const device = (agent as { device?: unknown }).device;
    if (device !== undefined && device !== null) return String(device);
  }
  return "unknown";
}

function urlFor(host: string, port: number): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${port}`;
}

function requestPath(rawUrl: string | undefined): string {
  let pathname = "/";
  try {
    pathname = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    pathname = "/";
  }
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.replace(/\/+$/, "");
  return pathname;
}

/* ------------------------------------------------------- error + validation */

interface ValidationItem {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

/** A failure that maps 1:1 onto a FastAPI HTTPException / validation response. */
class HttpError extends Error {
  // NB: explicit fields, not parameter properties — `node --experimental-strip-types`
  // (tests/project.test.ts) cannot strip parameter properties.
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

interface PickRequestBody {
  state: Record<string, unknown>;
  confidence_threshold?: number;
  attack_threshold?: number;
}

function missingField(input: unknown): HttpError {
  return new HttpError(422, {
    detail: [{ type: "missing", loc: ["body", "state"], msg: "Field required", input }],
  });
}

/** pydantic v2 `float | None = Field(None, ge=0.0, le=1.0)`. */
function validateThreshold(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined; // pydantic's None default
  let num: number;
  if (typeof value === "number") num = value;
  // pydantic's lax mode parses numeric strings for a float field
  else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) num = Number(value);
  else {
    throw new HttpError(422, {
      detail: [{
        type: "float_parsing", loc: ["body", field],
        msg: "Input should be a valid number, unable to parse string as a number", input: value,
      }],
    });
  }
  if (!Number.isFinite(num)) {
    throw new HttpError(422, {
      detail: [{
        type: "finite_number", loc: ["body", field], msg: "Input should be a finite number", input: value,
      }],
    });
  }
  const item = (type: string, msg: string, ctx: Record<string, unknown>): ValidationItem =>
    ({ type, loc: ["body", field], msg, input: value, ctx });
  if (num < 0) {
    throw new HttpError(422, {
      detail: [item("greater_than_equal", "Input should be greater than or equal to 0", { ge: 0 })],
    });
  }
  if (num > 1) {
    throw new HttpError(422, {
      detail: [item("less_than_equal", "Input should be less than or equal to 1", { le: 1 })],
    });
  }
  return num;
}

/** Parse + validate the POST body the way FastAPI validates `PickRequest`. */
export function validatePickBody(raw: string): PickRequestBody {
  if (raw.trim() === "") {
    // an absent body is a missing required body, not a JSON syntax error
    throw new HttpError(422, {
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HttpError(422, {
      detail: [{
        type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {},
        ctx: { error: err instanceof Error ? err.message : String(err) },
      }],
    });
  }
  if (!isRecord(parsed)) {
    throw new HttpError(422, {
      detail: [{
        type: "model_attributes_type", loc: ["body"],
        msg: "Input should be a valid dictionary or object to extract fields from", input: parsed,
      }],
    });
  }
  if (!("state" in parsed)) throw missingField(parsed);
  if (!isRecord(parsed.state)) {
    throw new HttpError(422, {
      detail: [{
        type: "dict_type", loc: ["body", "state"],
        msg: "Input should be a valid dictionary", input: parsed.state,
      }],
    });
  }
  const out: PickRequestBody = { state: parsed.state };
  const confidence = validateThreshold(parsed.confidence_threshold, "confidence_threshold");
  if (confidence !== undefined) out.confidence_threshold = confidence;
  const attack = validateThreshold(parsed.attack_threshold, "attack_threshold");
  if (attack !== undefined) out.attack_threshold = attack;
  return out;
}

/* ------------------------------------------------------------- http plumbing */

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * Reads the whole body. Oversized bodies are drained (not destroyed) so the 413
 * response reaches the client instead of an ECONNRESET.
 */
function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new HttpError(413, { detail: "Request body too large" }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, { detail: "Client disconnected" })));
  });
}

interface RequestContext {
  getPicker(): Promise<PickerLike>;
  log(line: string): void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const path = requestPath(req.url);

  if (path === "/health") {
    // Starlette adds HEAD to a GET route, so HEAD /health is a 200 too.
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { detail: "Method Not Allowed" }, { Allow: "GET" });
      return;
    }
    const picker = await ctx.getPicker();
    sendJson(res, 200, { status: "ok", device: deviceOf(picker) });
    return;
  }

  if (path === "/pick") {
    if (method !== "POST") {
      sendJson(res, 405, { detail: "Method Not Allowed" }, { Allow: "POST" });
      return;
    }
    // validate BEFORE touching the model: a bad request must not load a checkpoint
    const body = validatePickBody(await readBody(req));
    const picker = await ctx.getPicker();
    // Python mutates the resident picker, so an override sticks for later calls.
    if (body.confidence_threshold !== undefined) picker.conf_threshold = body.confidence_threshold;
    if (body.attack_threshold !== undefined) picker.attack_threshold = body.attack_threshold;
    const decision = await picker.pick(body.state);
    sendJson(res, 200, decision);
    return;
  }

  sendJson(res, 404, { detail: "Not Found" });
}

/* ------------------------------------------------------------------- server */

export function createPickerServer(opts: PickerServerOptions = {}): PickerServerHandle {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? ((line: string) => console.log(line));
  const factory = opts.loadPicker ?? defaultPickerFactory;

  let picker: PickerLike | null = opts.picker ?? null;
  let loading: Promise<PickerLike> | null = null;
  const getPicker = async (): Promise<PickerLike> => {
    if (picker) return picker;
    if (!loading) {
      const attempt = factory().then((loaded) => {
        picker = loaded;
        log(`[picker_server] model ready on ${deviceOf(loaded)}`);
        return loaded;
      });
      loading = attempt;
      attempt.catch(() => { if (loading === attempt) loading = null; });
    }
    return loading;
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, { getPicker, log }).catch((err: unknown) => {
      if (res.writableEnded) {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body);
        return;
      }
      log(`[picker_server] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      // Starlette's 500 body; the stack stays in the local log.
      sendJson(res, 500, { detail: "Internal Server Error" });
    });
  });
  // A malformed HTTP request would otherwise leak an open socket.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  let closed: Promise<void> | null = null;

  const handle: PickerServerHandle = {
    server,
    host,
    port: requestedPort,
    url: urlFor(host, requestedPort),
    async start(): Promise<PickerServerHandle> {
      if (server.listening) return handle;
      if (closed) { await closed; closed = null; } // support start -> close -> start
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => { server.off("listening", onListening); reject(err); };
        const onListening = (): void => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(requestedPort, host);
      });
      const address = server.address();
      if (address && typeof address === "object") handle.port = address.port;
      handle.url = urlFor(host, handle.port);
      return handle;
    },
    async close(): Promise<void> {
      if (closed) return closed;
      if (!server.listening) {
        closed = Promise.resolve();
        return closed;
      }
      closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch/undici keeps sockets alive, so a plain close() would hang here.
        server.closeAllConnections();
      });
      return closed;
    },
  };
  return handle;
}

/** create + listen; the returned handle carries the real (bound) port. */
export async function startPickerServer(opts: PickerServerOptions = {}): Promise<PickerServerHandle> {
  return createPickerServer(opts).start();
}

/* ---------------------------------------------------------------------- CLI */

export interface PickerServerArgs {
  host: string;
  port: number;
  help: boolean;
}

const USAGE = `laya quick-action picker server (Path B)

  picker-server [--host HOST] [--port PORT]

  --host  interface to bind   (default ${DEFAULT_HOST})
  --port  port to listen on   (default ${DEFAULT_PORT}, 0 = ephemeral)

Endpoints (same as picker_server.py / extension/background.js):
  GET  /health  -> {"status": "ok", "device": "..."}
  POST /pick    -> {"state": {url, title, main_text, visible_buttons}} -> decision`;

export function parseServerArgs(argv: readonly string[]): PickerServerArgs {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} requires a value`);
      return next;
    };
    if (name === "--help" || name === "-h") { help = true; continue; }
    if (name === "--host") { host = value(); continue; }
    if (name === "--port") {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`--port must be an integer in 0..65535, got ${raw}`);
      }
      port = parsed;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { host, port, help };
}

export interface PickerServerMainDeps {
  picker?: PickerLike;
  loadPicker?: PickerFactory;
  log?: (line: string) => void;
  /** Test/embedding seam: resolves the blocking wait. */
  signal?: AbortSignal;
}

/**
 * CLI entry point. Lists until SIGINT/SIGTERM (or `deps.signal` fires), then
 * closes the server. Returns the process exit code (0 ok, 2 bad arguments).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: PickerServerMainDeps = {},
): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在服务起来之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyRcToEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  const log = deps.log ?? ((line: string) => console.log(line));
  let args: PickerServerArgs;
  try {
    args = parseServerArgs(argv);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }

  const handle = await startPickerServer({
    host: args.host,
    port: args.port,
    picker: deps.picker,
    loadPicker: deps.loadPicker,
    log,
  });
  log(`[picker_server] listening on ${handle.url}`);

  let removeSignalHandlers: () => void = () => {};
  try {
    await new Promise<void>((resolve) => {
      if (deps.signal?.aborted) { resolve(); return; }
      const stop = (): void => resolve();
      removeSignalHandlers = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        deps.signal?.removeEventListener("abort", stop);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      deps.signal?.addEventListener("abort", stop, { once: true });
    });
  } finally {
    removeSignalHandlers();
    await handle.close();
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
