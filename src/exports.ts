import type { paths } from "./schema.js";
import { ProoflineError } from "./transport.js";

export type ExportParameters =
  paths["/api/v1/organizations/{org_id}/exports/{dataset}"]["get"]["parameters"];
export interface ExportPage {
  format: "csv" | "ndjson";
  text: string;
  rows: Record<string, unknown>[];
  version: 1 | 2;
  settledUntil: string;
  nextCursor: string | null;
}

// Version 2 of the finding datasets adds code-lane rows. Version 1 stays accepted from servers
// that have not moved to version 2.
const versions: Record<string, readonly string[]> = {
  findings: ["1", "2"],
  finding_validations: ["1", "2"],
};

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export interface SettledHorizon {
  seconds: bigint;
  fraction: string;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Parses an RFC 3339 timestamp with an explicit offset into an exact UTC instant. */
export function parseSettledHorizon(value: string): SettledHorizon | null {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  const sign = match[8];
  const offsetHour = match[9] ? Number(match[9]) : 0;
  const offsetMinute = match[10] ? Number(match[10]) : 0;
  if (month < 1 || month > 12) return null;
  const maxDay =
    month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (
    day < 1 ||
    day > maxDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const offsetSeconds =
    (sign === "-" ? -1 : 1) * (offsetHour * 3600 + offsetMinute * 60);
  const seconds =
    BigInt(Math.trunc(utc.getTime() / 1000)) - BigInt(offsetSeconds);
  return { seconds, fraction };
}

export function sameHorizon(a: SettledHorizon, b: SettledHorizon): boolean {
  return a.seconds === b.seconds && a.fraction === b.fraction;
}

function invalid(): never {
  throw new ProoflineError(
    200,
    "urn:proofline:sdk:invalid-response",
    "the export body or metadata is invalid",
  );
}

// RFC4180 fields retain embedded newlines, commas and doubled quotes.
function csv(text: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === "," || c === "\n" || c === "\r") {
      record.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        records.push(record);
        record = [];
        if (c === "\r" && text[i + 1] === "\n") i += 1;
      }
    } else if (c === '"' && field === "" && !closed) quoted = true;
    else {
      if (closed || c === '"') invalid();
      field += c;
    }
  }
  if (quoted) invalid();
  if (field !== "" || record.length || closed) records.push([...record, field]);
  const columns = records.shift();
  if (!columns || new Set(columns).size !== columns.length) invalid();
  return records.map((row) => {
    if (row.length !== columns.length) invalid();
    return Object.fromEntries(columns.map((name, i) => [name, row[i]]));
  });
}

export function decodeExport(
  text: string,
  headers: Headers,
  format: "csv" | "ndjson",
  dataset: string,
): ExportPage {
  const media = format === "csv" ? "text/csv" : "application/x-ndjson";
  const settledUntil = headers.get("x-proofline-export-settled-until");
  const version = headers.get("x-proofline-export-version") ?? "";
  if (
    headers.get("content-type")?.split(";")[0]?.trim() !== media ||
    !(versions[dataset] ?? ["1"]).includes(version) ||
    !settledUntil ||
    parseSettledHorizon(settledUntil) === null
  )
    invalid();
  let rows: Record<string, unknown>[];
  try {
    rows =
      format === "csv"
        ? csv(text)
        : text
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => {
              const row: unknown = JSON.parse(line);
              if (!row || typeof row !== "object" || Array.isArray(row))
                invalid();
              return row as Record<string, unknown>;
            });
    if (rows.some((row) => String(row.dataset_version) !== version)) invalid();
  } catch {
    invalid();
  }
  return {
    format,
    text,
    rows,
    version: version === "2" ? 2 : 1,
    settledUntil,
    nextCursor: headers.get("x-proofline-export-next-cursor"),
  };
}
