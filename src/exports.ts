import type { paths } from "./schema.js";
import { ProoflineError } from "./transport.js";

export type ExportParameters =
  paths["/api/v1/organizations/{org_id}/exports/{dataset}"]["get"]["parameters"];
export interface ExportPage {
  format: "csv" | "ndjson";
  text: string;
  rows: Record<string, unknown>[];
  version: 1;
  settledUntil: string;
  nextCursor: string | null;
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
): ExportPage {
  const media = format === "csv" ? "text/csv" : "application/x-ndjson";
  const settledUntil = headers.get("x-proofline-export-settled-until");
  if (
    headers.get("content-type")?.split(";")[0]?.trim() !== media ||
    headers.get("x-proofline-export-version") !== "1" ||
    !settledUntil ||
    !Number.isFinite(Date.parse(settledUntil))
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
    if (rows.some((row) => String(row.dataset_version) !== "1")) invalid();
  } catch {
    invalid();
  }
  return {
    format,
    text,
    rows,
    version: 1,
    settledUntil,
    nextCursor: headers.get("x-proofline-export-next-cursor"),
  };
}
