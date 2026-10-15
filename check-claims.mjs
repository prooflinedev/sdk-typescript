import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

const forbidden = new Set(["safe", "passed", "clean"]);
const failures = [];

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      await inspect(new URL(`${entry.name}/`, directory));
    } else if (entry.name.endsWith(".ts")) {
      const source = ts.createSourceFile(
        path.pathname,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function visit(node) {
        if (
          (ts.isPropertySignature(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isMethodSignature(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isFunctionDeclaration(node)) &&
          node.name &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
          words(node.name.text).some((word) => forbidden.has(word))
        ) {
          failures.push(`${path.pathname}: ${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}

await inspect(new URL("src/", import.meta.url));
if (failures.length > 0) {
  throw new Error(
    `SDK fields and methods must not claim deployment permission:\n${failures.join("\n")}`,
  );
}
