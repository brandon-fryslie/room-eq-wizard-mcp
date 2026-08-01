// [LAW:effects-at-boundaries] Every byte exchanged with REW passes through this
// file. Tools and analysis code never touch fetch, URLs, or HTTP status codes.
// [LAW:single-enforcer] HTTP error mapping and long-command completion each have
// exactly one implementation here — the reference repos repeated the blocking-mode
// dance in five separate tools; that duplication is what this class exists to prevent.

import type { z } from "zod";

export class RewApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "RewApiError";
  }
}

export interface RewClientOptions {
  /** Base URL of the REW API. Default http://127.0.0.1:4735 (REW is local-only). */
  baseUrl?: string;
  /** Timeout for reads and quick settings writes. Default 15s. */
  readTimeoutMs?: number;
  /** Timeout for long-running commands (sweeps, EQ matching). Default 180s. */
  commandTimeoutMs?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

export class RewClient {
  readonly baseUrl: string;
  private readonly readTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  // [LAW:no-ambient-temporal-coupling] REW answers long commands synchronously only
  // in its "blocking" mode; this flag makes that precondition owned state, enabled
  // once before the first command rather than hoped-for per call site.
  private blockingEnabled = false;

  constructor(options: RewClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4735").replace(/\/$/, "");
    this.readTimeoutMs = options.readTimeoutMs ?? 15_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 180_000;
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Query; timeoutMs: number },
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (error) {
      throw new RewApiError(
        `REW API unreachable at ${this.baseUrl} (${(error as Error).message}). ` +
          `Start REW with the -api flag (macOS: open -a REW.app --args -api) ` +
          `or enable the API server in REW Preferences → API.`,
      );
    }
    const text = await response.text();
    // 202 Accepted is REW's "command started" — a success shape, not an error.
    if (!response.ok && response.status !== 202) {
      throw new RewApiError(
        `REW API ${method} ${path} → ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`,
        response.status,
        text,
      );
    }
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text; // some endpoints answer with a bare string
    }
  }

  /** GET and stamp: raw JSON in, schema-parsed value out. */
  async get<T>(path: string, schema: z.ZodType<T>, query?: Query): Promise<T> {
    const raw = await this.request("GET", path, { query, timeoutMs: this.readTimeoutMs });
    return schema.parse(raw);
  }

  /** Quick settings write (generator level, sweep configuration, target settings…). */
  async post(path: string, body?: unknown, query?: Query): Promise<unknown> {
    return this.request("POST", path, { body, query, timeoutMs: this.readTimeoutMs });
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", path, { body, timeoutMs: this.readTimeoutMs });
  }

  async delete(path: string): Promise<unknown> {
    return this.request("DELETE", path, { timeoutMs: this.readTimeoutMs });
  }

  /**
   * Run a REW command that takes time (sweep, EQ match, RT60 generation,
   * measurement processing). Enables REW's blocking mode once per client, so
   * the HTTP response arrives only when the command has completed.
   */
  async command(path: string, body: unknown): Promise<unknown> {
    if (!this.blockingEnabled) {
      await this.request("POST", "/application/blocking", {
        body: true,
        timeoutMs: this.readTimeoutMs,
      });
      this.blockingEnabled = true;
    }
    return this.request("POST", path, { body, timeoutMs: this.commandTimeoutMs });
  }
}
