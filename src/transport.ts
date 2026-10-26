const VERSION = "1.0.3";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 3;
const MAX_RETRY_SECONDS = 60;
const inspect = Symbol.for("nodejs.util.inspect.custom");

export class SecretToken {
  readonly #value: string;

  constructor(value: string) {
    if (
      !value ||
      /\s/.test(value) ||
      Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    ) {
      throw new TypeError(
        "a nonempty Proofline token without whitespace is required",
      );
    }
    this.#value = value;
  }

  apply(headers: Headers): void {
    headers.set("Authorization", `Bearer ${this.#value}`);
  }

  toString(): string {
    return "SecretToken([redacted])";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect](): string {
    return this.toString();
  }
}

export class ProoflineError extends Error {
  readonly #problemType: string;
  readonly #detail: string;

  constructor(
    readonly status: number,
    type: string,
    detail: string,
  ) {
    super(`Proofline request failed with status ${status}`);
    this.name = "ProoflineError";
    this.#problemType = type;
    this.#detail = detail;
  }

  get type(): string {
    return this.#problemType;
  }

  get detail(): string {
    return this.#detail;
  }

  toJSON(): { status: number } {
    return { status: this.status };
  }

  [inspect](): string {
    return this.toString();
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string | SecretToken;
  requestTimeoutMs?: number;
}

export interface Parameters {
  path?: object;
  query?: object;
}

export type Invoke = <T>(
  method: string,
  template: string,
  parameters: Parameters,
  body?: object,
) => Promise<T>;

function environmentToken(): string | undefined {
  return typeof process === "undefined"
    ? undefined
    : process.env.PROOFLINE_TOKEN;
}

function origin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "baseUrl must be an absolute HTTPS URL or loopback HTTP URL",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new TypeError(
      "baseUrl must be an HTTPS origin or loopback HTTP origin without credentials",
    );
  }
  return url;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number`);
  }
  return value;
}

async function decoded(
  response: Response,
  deadline: number,
  signal: AbortSignal,
  waitTimeout: boolean,
  decode: (text: string, headers: Headers) => unknown,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ProoflineError(
      response.status,
      "urn:proofline:sdk:invalid-response",
      "the response has no JSON body",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProoflineError(
          response.status,
          "urn:proofline:sdk:invalid-response",
          "the response exceeds 8 MiB",
        );
      }
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return response.ok
      ? decode(text, response.headers)
      : (JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof ProoflineError) throw error;
    if (response.ok && (signal.aborted || performance.now() >= deadline))
      throw new ProoflineError(
        0,
        waitTimeout
          ? "urn:proofline:sdk:timeout"
          : "urn:proofline:sdk:transport",
        waitTimeout
          ? "the review wait deadline expired"
          : "the successful response body did not finish within its timeout",
      );
    throw new ProoflineError(
      response.status,
      "urn:proofline:sdk:invalid-response",
      "the response is not valid UTF-8 JSON",
    );
  } finally {
    reader.releaseLock();
  }
}

function problem(status: number, value: unknown): ProoflineError {
  const body =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return new ProoflineError(
    status,
    typeof body.type === "string" ? body.type : "about:blank",
    typeof body.detail === "string"
      ? body.detail
      : "the server refused the request without a problem detail",
  );
}

function retryDelay(
  header: string | null,
  attempt: number,
): number | undefined {
  if (header === null) return Math.min(2 ** attempt, MAX_RETRY_SECONDS) * 1000;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header)
    : Math.max(0, (httpDate(header.trim()) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds <= MAX_RETRY_SECONDS
    ? seconds * 1000
    : undefined;
}

function httpDate(value: string): number {
  let canonical = value;
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  ) {
    const obsolete =
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(
        value,
      );
    const asctime =
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(
        value,
      );
    if (obsolete) {
      const futureLimit = new Date();
      const currentYear = futureLimit.getUTCFullYear();
      const year = Math.floor(currentYear / 100) * 100 + Number(obsolete[4]);
      canonical = `${obsolete[1]?.slice(0, 3)}, ${obsolete[2]} ${obsolete[3]} ${year} ${obsolete[5]} GMT`;
      futureLimit.setUTCFullYear(currentYear + 50);
      if (Date.parse(canonical) > futureLimit.getTime())
        canonical = `${obsolete[1]?.slice(0, 3)}, ${obsolete[2]} ${obsolete[3]} ${year - 100} ${obsolete[5]} GMT`;
    } else if (asctime) {
      canonical = `${asctime[1]}, ${asctime[3]?.trim().padStart(2, "0")} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT`;
    } else {
      return Number.NaN;
    }
  }
  const timestamp = Date.parse(canonical);
  return new Date(timestamp).toUTCString() === canonical
    ? timestamp
    : Number.NaN;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class Transport {
  readonly #base: URL;
  readonly #token: SecretToken;
  readonly #timeout: number;

  constructor(options: ClientOptions) {
    this.#base = origin(options.baseUrl);
    const token = options.token ?? environmentToken();
    this.#token =
      token instanceof SecretToken ? token : new SecretToken(token ?? "");
    this.#timeout = positive(
      options.requestTimeoutMs ?? 30_000,
      "requestTimeoutMs",
    );
  }

  reviewUrl(orgId: string, reviewId: string): string {
    return new URL(
      `/orgs/by-id/${coordinate(orgId)}/reviews/${coordinate(reviewId)}`,
      this.#base,
    ).href;
  }

  async request<T>(
    method: string,
    template: string,
    parameters: Parameters,
    deadline?: number,
    body?: object,
    decode: (text: string, headers: Headers) => unknown = (text) =>
      JSON.parse(text),
    accept = "application/json, application/problem+json",
    mcpPhase?: "initialize" | "notification" | "call",
  ): Promise<T> {
    const path = Object.entries(parameters.path ?? {}).reduce(
      (value, [key, coordinateValue]) =>
        value.replace(`{${key}}`, coordinate(coordinateValue)),
      template,
    );
    if (/[{}]/.test(path))
      throw new TypeError("a required path coordinate is missing");
    const url = new URL(path, this.#base);
    for (const [key, value] of Object.entries(parameters.query ?? {})) {
      if (value !== null && value !== undefined)
        url.searchParams.set(key, String(value));
    }
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    if (mcpPhase && new TextEncoder().encode(requestBody).length > 8192)
      throw new TypeError("MCP request exceeds 8192 bytes");
    for (let attempt = 0; ; attempt += 1) {
      const headers = new Headers({
        Accept: accept,
        "User-Agent": `proofline-typescript/${VERSION}`,
      });
      if (requestBody !== undefined)
        headers.set("Content-Type", "application/json");
      if (mcpPhase) {
        headers.set("Origin", this.#base.origin);
        if (mcpPhase !== "initialize")
          headers.set("MCP-Protocol-Version", "2025-11-25");
      }
      this.#token.apply(headers);
      const now = performance.now();
      const waitRemaining =
        deadline === undefined ? this.#timeout : deadline - now;
      const remaining = Math.min(this.#timeout, waitRemaining);
      const waitTimeout =
        deadline !== undefined && waitRemaining <= this.#timeout;
      if (remaining <= 0)
        throw new ProoflineError(
          0,
          "urn:proofline:sdk:timeout",
          "the request deadline expired",
        );
      const requestDeadline = now + remaining;
      const signal = AbortSignal.timeout(Math.ceil(remaining));
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          redirect: "manual",
          credentials: "omit",
          signal,
        });
      } catch {
        if (signal.aborted && waitTimeout)
          throw new ProoflineError(
            0,
            "urn:proofline:sdk:timeout",
            "the review wait deadline expired",
          );
        throw new ProoflineError(
          0,
          "urn:proofline:sdk:transport",
          "the request did not receive a response within its timeout",
        );
      }
      if (mcpPhase && response.ok) {
        const notification = mcpPhase === "notification";
        if (
          response.status !== (notification ? 202 : 200) ||
          response.headers.has("mcp-session-id") ||
          (!notification &&
            response.headers.get("content-type")?.split(";")[0]?.trim() !==
              "application/json")
        ) {
          await response.body?.cancel();
          throw new ProoflineError(
            0,
            "urn:proofline:sdk:mcp",
            "Unsupported MCP response",
          );
        }
        if (notification && !response.body) return undefined as T;
      }
      const value = await decoded(
        response,
        requestDeadline,
        signal,
        waitTimeout,
        decode,
      );
      if (response.ok) return value as T;
      const error = problem(response.status, value);
      const delay = retryDelay(response.headers.get("Retry-After"), attempt);
      if (
        method !== "GET" ||
        ![429, 503].includes(response.status) ||
        attempt >= MAX_RETRIES ||
        delay === undefined
      )
        throw error;
      if (deadline !== undefined && performance.now() + delay >= deadline) {
        throw new ProoflineError(
          0,
          "urn:proofline:sdk:timeout",
          "the review timeout expires before the server permits a retry",
        );
      }
      await sleep(delay);
    }
  }
}

function coordinate(value: unknown): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    value === "" ||
    value === "." ||
    value === ".."
  ) {
    throw new TypeError(
      "path coordinates must be nonempty strings or numbers without traversal segments",
    );
  }
  return encodeURIComponent(String(value));
}
