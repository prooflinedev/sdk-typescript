import type { components } from "./schema.js";

const VERSION = "9.2.0";
const DEFAULT_BASE_URL = "https://proofline.sh";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 3;
const MAX_RETRY_SECONDS = 60;
const inspect = Symbol.for("nodejs.util.inspect.custom");
const secrets = new WeakMap<SecretToken, string>();
const rawJsonBodies = new WeakMap<object, string | undefined>();

export function rawJson(json: string | undefined): object {
  const marker = {};
  rawJsonBodies.set(marker, json);
  return marker;
}

/** Why a review request created nothing; `reason` names the setting to change. */
export type RunNowRefusal = components["schemas"]["RunNowRefusalView"];

export interface ProblemFields {
  title?: string;
  refusal?: RunNowRefusal;
  repositoryName?: string;
}

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
    secrets.set(this, value);
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
  readonly #fields: ProblemFields;

  constructor(
    readonly status: number,
    type: string,
    detail: string,
    fields: ProblemFields = {},
  ) {
    super(`Proofline request failed with status ${status}`);
    this.name = "ProoflineError";
    this.#problemType = type;
    this.#detail = detail;
    this.#fields = fields;
  }

  get type(): string {
    return this.#problemType;
  }

  get detail(): string {
    return this.#detail;
  }

  /** The server's problem class, such as `invalid request`. */
  get title(): string | undefined {
    return this.#fields.title;
  }

  /** The typed refusal of a review request that created nothing. */
  get refusal(): RunNowRefusal | undefined {
    return this.#fields.refusal;
  }

  /** The refused repository's name within its owner. */
  get repositoryName(): string | undefined {
    return this.#fields.repositoryName;
  }

  toJSON(): { status: number } {
    return { status: this.status };
  }

  [inspect](): string {
    return this.toString();
  }
}

export interface ClientOptions {
  /** Defaults to `PROOFLINE_BASE_URL`, then to `https://proofline.sh`. */
  baseUrl?: string;
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

function environmentBaseUrl(): string | undefined {
  if (typeof process === "undefined") return undefined;
  // An empty variable, as a CI template leaves behind, counts as unset.
  return process.env.PROOFLINE_BASE_URL || undefined;
}

function origin(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `${name} must be an absolute HTTPS URL or loopback HTTP URL`,
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
      `${name} must be an HTTPS origin or loopback HTTP origin without credentials`,
    );
  }
  return url;
}

function configuredOrigin(baseUrl: string | undefined): URL {
  if (baseUrl !== undefined) return origin(baseUrl, "baseUrl");
  const fromEnvironment = environmentBaseUrl();
  return fromEnvironment === undefined
    ? origin(DEFAULT_BASE_URL, "baseUrl")
    : origin(fromEnvironment, "PROOFLINE_BASE_URL");
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
    if (!response.ok) return undefined;
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
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (response.ok) return decode(decoder.decode(data), response.headers);
    try {
      return JSON.parse(decoder.decode(data)) as unknown;
    } catch {
      // A complete HTTP refusal need not carry a UTF-8 JSON Problem to be retryable.
      return undefined;
    }
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

type Body = Record<string, unknown>;

function record(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redacted(value: unknown, secret: string): unknown {
  if (typeof value === "string")
    return secret ? value.replaceAll(secret, "[redacted]") : value;
  if (Array.isArray(value)) return value.map((item) => redacted(item, secret));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redacted(item, secret)]),
    );
  return value;
}

function environment(value: unknown): boolean {
  return (
    record(value) &&
    ["id", "external_key