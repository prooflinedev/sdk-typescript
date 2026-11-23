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
    if (index === "i/-text") continue; // binary file
    if (
      index === "i/crlf" ||
      index === "i/mixed" ||
      !/\beol=lf\b/.test(attributes)
    ) {
      wrong.push(`${entry.slice(tab + 1)} (${index} ${attributes})`);
    }
  }
  assert.deepEqual(wrong, []);
});
