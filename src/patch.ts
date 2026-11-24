import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { RequestPatchReviewBody } from "./operations.js";
import type { components } from "./schema.js";

export interface GitPatchChanges {
  /**
   * The commit the patch applies to, as any revision Git resolves, such as
   * `origin/main` or a SHA. It is resolved to the full commit SHA that is sent,
   * and GitHub must already have that commit.
   */
  base: string;
  /**
   * A committed head to compare with `base`. Without it, the tracked files of
   * the work tree are compared, staged or not; untracked files are left out.
   */
  head?: string;
  /** A directory inside the repository. Defaults to the working directory. */
  cwd?: string;
  /** Open findings of one pull request to re-verify against the patch, at most 20. */
  verify_finding_ids?: string[];
  /** The git hook sending this request, when one is. */
  trigger_source?: components["schemas"]["PatchTriggerSource"];
}

const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_PATCH_FILES = 3_000;
// Room for the --raw path records that precede the patch; the patch itself is
// measured exactly once it is split off.
const MAX_OUTPUT_BYTES = MAX_PATCH_BYTES + MAX_PATCH_FILES * 8_400;
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The server reads `git diff --no-ext-diff --no-color <base>` output and
// refuses prefix-less paths and copies. These options hold that shape whatever
// the person's Git configuration asks for (diff.noprefix, diff.mnemonicPrefix,
// diff.renames=copies, diff.relative, diff.submodule, color.ui, diff.external,
// textconv drivers).
const DIFF_ARGS = [
  "--literal-pathspecs",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--raw",
  "-z",
  "--patch",
  "--find-renames",
  "--no-relative",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

function git(cwd: string, command: string, args: string[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // A read must not take index.lock from a commit or hook running beside it.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return done(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT")
          return fail(
            new Error("git is not installed or not on PATH", { cause: error }),
          );
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return fail(
            new TypeError(
              "the changes make a patch over the 5 MiB review limit",
            ),
          );
        const detail = stderr.toString("utf8").trim().split("\n")[0];
        fail(
          new Error(`git ${command} failed: ${detail || error.message}`, {
            cause: error,
          }),
        );
      },
    );
  });
}

async function commit(cwd: string, name: string, revision: string) {
  // A revision that starts with "-" would be read as an option.
  if (revision === "" || revision.startsWith("-"))
    throw new TypeError(`${name} must name a commit`);
  let output: Buffer;
  try {
    output = await git(cwd, "rev-parse", [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
  } catch (error) {
    // `rev-parse --verify --quiet` exits 1, silently, for a revision it cannot
    // resolve; anything else (no repository, no git) keeps its own message.
    if (!(error instanceof Error && exitCode(error.cause) === 1)) throw error;
    throw new TypeError(
      `${name} ${JSON.stringify(revision)} names no commit in this repository`,
    );
  }
  const sha = output.toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new TypeError(`${name} must resolve to a SHA-1 commit`);
  return sha;
}

function exitCode(error: unknown): unknown {
  return error instanceof Error
    ? (error as { code?: unknown }).code
    : undefined;
}

interface RawEntry {
  srcMode: string;
  dstMode: string;
  status: string;
  paths: string[];
}

function text(bytes: Buffer, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new TypeError(`${what} is not UTF-8 text`);
  }
}

/** Splits `--raw -z --patch` output into its path records and the patch text. */
function split(output: Buffer): { entries: RawEntry[]; patch: Buffer } {
  const entries: RawEntry[] = [];
  let offset = 0;
  const field = () => {
    const end = output.indexOf(0, offset);
    if (end < 0) throw malformed();
    const value = output.subarray(offset, end);
    offset = end + 1;
    return value;
  };
  while (offset < output.length) {
    if (output[offset] !== 0x3a /* ":" */) break;
    const header = field().toString("latin1").slice(1).split(" ");
    const [srcMode, dstMode, , , status] = header;
    if (header.length !== 5 || !srcMode || !dstMode || !status)
      throw malformed();
    const kind = status[0] ?? "";
    if (kind === "" || !"ADMTR".includes(kind))
      throw new TypeError(
        kind === "U"
          ? "the changes include unmerged paths; resolve them before review"
          : `the changes include a ${kind} entry, which a patch review refuses`,
      );
    const paths = [text(field(), "a changed path")];
    if (kind === "R") paths.push(text(field(), "a changed path"));
    entries.push({ srcMode, dstMode, status: kind, paths });
  }
  // Git separates the records from the patch with one NUL.
  if (entries.length && output[offset] === 0) offset += 1;
  return { entries, patch: output.subarray(offset) };
}

function malformed(): Error {
  return new Error(
    "could not read Git's diff path records; no review was requested",
  );
}

/**
 * Builds a patch review body from a local Git checkout, refusing locally what
 * the server would refuse: no changes, binary files, symbolic links,
 * submodules, non-UTF-8 text, more than 3,000 files, or more than 5 MiB.
 */
export async function readGitPatch(
  changes: GitPatchChanges,
): Promise<RequestPatchReviewBody> {
  const cwd = resolve(changes.cwd ?? ".");
  const base = await commit(cwd, "base", changes.base);
  const head =
    changes.head === undefined
      ? undefined
      : await commit(cwd, "head", changes.head);
  const output = await git(cwd, "diff", [
    ...DIFF_ARGS,
    base,
    ...(head === undefined ? [] : [head]),
    "--",
  ]);
  const { entries, patch: bytes } = split(output);
  if (!entries.length) throw new TypeError("there are no changes to review");
  for (const entry of entries) {
    const path = entry.paths.at(-1);
    if (entry.srcMode === SUBMODULE_MODE || entry.dstMode === SUBMODULE_MODE)
      throw new TypeError(
        `${path} is a submodule, which a patch review refuses`,
      );
    if (entry.srcMode === SYMLINK_MODE || entry.dstMode === SYMLINK_MODE)
      throw new TypeError(
        `${path} is a symbolic link, which a patch review refuses`,
      );
  }
  if (entries.length > MAX_PATCH_FILES)
    throw new TypeError(
      `the changes include ${entries.length} files; a patch review takes at most ${MAX_PATCH_FILES}`,
    );
  if (bytes.length > MAX_PATCH_BYTES)
    throw new TypeError("the changes make a patch over the 5 MiB review limit");
  const patch = text(bytes, "the patch");
  const lines = patch.split("\n");
  const binary = lines.find(
    (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
  );
  if (binary !== undefined)
    throw new TypeError(
      `the changes include a binary file, which a patch review refuses: ${binary}`,
    );
  // Each record must have its own file section, or the two were misread.
  if (
    lines.filter((line) => line.startsWith("diff --git ")).length !==
    entries.length
  )
    throw malformed();
  const body: RequestPatchReviewBody = { base_commit_sha: base, patch };
  if (changes.verify_finding_ids !== undefined)
    body.verify_finding_ids = [...changes.verify_finding_ids];
  if (changes.trigger_source !== undefined)
    body.trigger_source = changes.trigger_source;
  return body;
}
