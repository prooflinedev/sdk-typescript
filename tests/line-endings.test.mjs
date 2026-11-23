import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Biome formats with LF. Without a Git rule, Git for Windows checks text files
// out with CRLF, and `pnpm lint` then reports every file as misformatted.
test("Git stores and checks out every tracked text file with LF", () => {
  const listing = execFileSync("git", ["ls-files", "--eol", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  const wrong = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    // "i/lf    w/crlf  attr/text=auto eol=lf \tpath": index, working copy, rule
    const tab = entry.indexOf("\t");
    const info = entry.slice(0, tab);
    const index = info.split(" ")[0];
    const attributes = info.slice(info.indexOf("attr/")).trim();
    const rules = attributes.slice("attr/".length).split(/\s+/);
    const problem = `${entry.slice(tab + 1)} (${index} ${attributes})`;
    // No file may be stored with CRLF, whatever its rules say.
    if (index === "i/crlf" || index === "i/mixed") {
      wrong.push(problem);
      continue;
    }
    // A binary file is skipped only when the rules let Git treat it as binary:
    // "-text", or no explicit "text" and content Git detects as binary.
    if (rules.includes("-text")) continue;
    if (index === "i/-text" && !rules.includes("text")) continue;
    if (!rules.includes("eol=lf")) wrong.push(problem);
  }
  assert.deepEqual(wrong, []);
});
