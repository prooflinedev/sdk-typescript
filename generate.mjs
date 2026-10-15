import { readFile, writeFile } from "node:fs/promises";

const document = JSON.parse(
  await readFile(new URL("./openapi.public.json", import.meta.url), "utf8"),
);
const methods = [];
const aliases = [];
const ids = new Set();
for (const [path, item] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    const id = operation.operationId;
    if (!/^[a-z][a-z0-9_]*$/.test(id) || ids.has(id)) {
      throw new Error(
        "each public operation requires a unique, stable operationId",
      );
    }
    ids.add(id);
    const name = id.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    const type = name[0].toUpperCase() + name.slice(1);
    const success = Object.entries(operation.responses).find(([status]) =>
      /^2\d\d$/.test(status),
    )?.[1];
    const reference = success?.content?.["application/json"]?.schema?.$ref;
    if (id === "export_reviews") {
      const media = success?.content;
      const rows = document.components?.schemas?.ExportRow?.anyOf;
      if (
        path !== "/api/v1/organizations/{org_id}/exports/{dataset}" ||
        method !== "get" ||
        Object.keys(media ?? {})
          .sort()
          .join(",") !== "application/x-ndjson,text/csv" ||
        Object.values(media).some(
          (value) =>
            value.schema?.$ref !==
              "#/components/schemas/ReviewsMetadataStream" ||
            value["x-proofline-row-schema"]?.$ref !==
              "#/components/schemas/ExportRow",
        ) ||
        !Array.isArray(rows) ||
        rows.length !== 5 ||
        rows.some(
          (row) =>
            row === null ||
            typeof row !== "object" ||
            Object.keys(row).join(",") !== "$ref",
        ) ||
        rows
          .map((row) => row.$ref)
          .sort()
          .join(",") !==
          "#/components/schemas/FindingOutcomesExportRow,#/components/schemas/FindingValidationsExportRow,#/components/schemas/FindingsExportRow,#/components/schemas/ReviewsExportRow,#/components/schemas/SpendExportRow"
      ) {
        throw new Error(
          "export_reviews requires its declared metadata stream and row schemas",
        );
      }
      // These transports decode JSON. The metadata file uses the public
      // HTTP contract, rather than a convenience method with a false type.
      continue;
    }
    if (
      Object.keys(success?.content ?? {}).join(",") !== "application/json" ||
      !reference?.startsWith("#/components/schemas/")
    ) {
      throw new Error(`${id} requires a named response schema`);
    }
    const response = reference.slice("#/components/schemas/".length);
    aliases.push(
      `export type ${type}Parameters = paths[${JSON.stringify(path)}][${JSON.stringify(method)}]["parameters"];`,
    );
    let bodyParameter = "";
    let bodyArgument = "";
    if (operation.requestBody !== undefined) {
      const body = operation.requestBody;
      const reference = body.content?.["application/json"]?.schema?.$ref;
      if (
        Object.keys(body.content ?? {}).join(",") !== "application/json" ||
        !reference?.startsWith("#/components/schemas/")
      ) {
        throw new Error(`${id} requires a named JSON request schema`);
      }
      aliases.push(
        `export type ${type}Body = NonNullable<paths[${JSON.stringify(path)}][${JSON.stringify(method)}]["requestBody"]>["content"]["application/json"];`,
      );
      bodyParameter = `, body${body.required === true ? "" : "?"}: ${type}Body`;
      bodyArgument = ", body";
    }
    methods.push(`  ${name}(parameters: ${type}Parameters${bodyParameter}): Promise<components["schemas"][${JSON.stringify(response)}]> {
    return this.invoke(${JSON.stringify(method.toUpperCase())}, ${JSON.stringify(path)}, parameters${bodyArgument});
  }`);
  }
}
const output = `// Generated from the public operationIds. Regenerate with pnpm generate.
import type { components, paths } from "./schema.js";
import type { Invoke } from "./transport.js";

${aliases.join("\n")}

export class Operations {
  constructor(private readonly invoke: Invoke) {}

${methods.join("\n\n")}
}
`;
const destination = new URL("src/operations.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== output) {
    throw new Error("public operations differ; run pnpm generate");
  }
} else {
  await writeFile(destination, output);
}
