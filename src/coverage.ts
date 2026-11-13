import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { UploadCoverageReportsBody } from "./operations.js";

export interface CoverageFile {
  /** Path to the report on disk, absolute or relative to `root`. */
  path: string;
  /** Report name sent to the server. Defaults to `path` relative to `root`. */
  name?: string;
}

export interface CoverageFilesUpload {
  /** The full 40-character commit the tests ran on. */
  tested_sha: string;
  /** One to 50 report paths, or `{ path, name }` to choose the sent name. */
  files: (string | CoverageFile)[];
  /** Directory that report paths and default names resolve against. Defaults to the working directory. */
  root?: string;
}

const MAX_REPORTS = 50;
const MAX_BODY_BYTES = 30 * 1024 * 1024;

// Keeps a byte-order mark and refuses invalid UTF-8, so content stays the report text as written.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function reportName(name: string): string {
  const segments = name.split("/");
  if (
    name === "" ||
    name.includes("\\") ||
    isAbsolute(name) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new TypeError(
      `coverage report name ${JSON.stringify(name)} must be a relative path inside root`,
    );
  return name;
}

/**
 * Reads coverage reports from disk into an upload body, refusing locally what
 * the server would refuse: an abbreviated SHA, a report count outside 1 to 50,
 * duplicate or escaping names, non-UTF-8 content, or a body over 30 MiB.
 */
export async function readCoverageFiles(
  upload: CoverageFilesUpload,
): Promise<UploadCoverageReportsBody> {
  if (!/^[0-9a-f]{40}$/i.test(upload.tested_sha))
    throw new TypeError("tested_sha must be a full 40-character commit SHA");
  if (upload.files.length < 1 || upload.files.length > MAX_REPORTS)
    throw new TypeError(`upload 1 to ${MAX_REPORTS} coverage reports`);
  const root = resolve(upload.root ?? ".");
  const files = upload.files.map((file) => {
    const entry = typeof file === "string" ? { path: file } : file;
    const path = resolve(root, entry.path);
    const name = reportName(
      entry.name ?? relative(root, path).split(sep).join("/"),
    );
    return { path, name };
  });
  const names = new Set(files.map((file) => file.name));
  if (names.size !== files.length)
    throw new TypeError("coverage report names must be unique");
  // Report bytes alone can exceed the body limit; check sizes before reading.
  let bytes = 0;
  for (const file of files) {
    bytes += (await stat(file.path)).size;
    if (bytes > MAX_BODY_BYTES)
      throw new TypeError("coverage reports exceed the 30 MiB upload limit");
  }
  const reports = [];
  for (const file of files) {
    let content: string;
    try {
      content = utf8.decode(await readFile(file.path));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new TypeError(`coverage report ${file.name} is not UTF-8 text`);
    }
    reports.push({ name: file.name, content });
  }
  const body = { tested_sha: upload.tested_sha, reports };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES)
    throw new TypeError("coverage reports exceed the 30 MiB upload limit");
  return body;
}
