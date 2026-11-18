import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const importedDotfiles = [
  ".cjs",
  ".CJS",
  ".JS",
  ".MJS",
  ".jsx",
  ".JSX",
  ".ts",
  ".TS",
  ".mts",
  ".MTS",
  ".cts",
  ".CTS",
  ".tsx",
  ".TSX",
].map((name, index) => ({
  path: `esm/dot-${index}/${name}`,
  specifier: `./dot-${index}/${name}`,
}));

const fixture = async () => {
  const root = await createTestTempDirectory("rea-bom-hashbang-");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "commonjs", main: "module.mjs" }),
    "module.mjs":
      '\uFEFF#!/usr/bin/env node\nconst face="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/package.json": JSON.stringify({ type: "module" }),
    "esm/main.js":
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/.js":
      '\uFEFF#!/usr/bin/env node\nimport {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/.mjs":
      '\uFEFF#!/usr/bin/env node\nimport {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "view.jsx":
      '\uFEFF#!/usr/bin/env node\nconst element = <div/>; import "./dep.mjs";',
    "typed.mts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "typed.cts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; const {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "imported.cjs":
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; if (false) return; const {marker}=require("./dep.cjs"); module.exports={marker};',
    "imported.js":
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; if (false) return; const {marker}=require("./dep.cjs"); module.exports={marker};',
    "invoke-cjs.mjs":
      'import cjs from "./imported.cjs"; import js from "./imported.js"; console.log(JSON.stringify([cjs.marker, js.marker]));',
    "malformed.cjs": "\uFEFF#!/usr/bin/env node\nconst value = ;",
    "plain.cjs":
      '#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "dep.mjs": "export const marker=42;",
    "dep.cjs": "exports.marker=42;",
    ...Object.fromEntries(
      importedDotfiles.map(({ path }) => [
        path,
        '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "../../dep.mjs"; export {marker};',
      ]),
    ),
    "esm/invoke.mjs": `const modules = await Promise.all([${importedDotfiles.map(({ specifier }) => `import(${JSON.stringify(specifier)})`).join(",")}]); console.log(JSON.stringify(modules.map(({marker}) => marker)));`,
  };
  await writeFixtureFiles(root, files);
  return { root, files };
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "analyzes BOM/hashbang modules with original Evidence through %s",
  async (surface, { cli }) => {
    const { root, files } = await fixture();
    for (const path of [
      "module.mjs",
      "esm/main.js",
      "esm/.js",
      "esm/.mjs",
      "typed.mts",
      "typed.cts",
      "plain.cjs",
    ])
      expect(await runNodeJsonControl(root, path)).toEqual({ marker: 42 });
    for (const path of ["imported.cjs", "imported.js"])
      await expect(runNodeJsonControl(root, path)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SyntaxError"),
      });
    expect(await runNodeJsonControl(root, "invoke-cjs.mjs")).toEqual([42, 42]);
    expect(await runNodeJsonControl(root, "esm/invoke.mjs")).toEqual(
      importedDotfiles.map(() => 42),
    );
    await expect(
      runNodeJsonControl(root, "esm/dot-0/.cjs"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SyntaxError"),
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(1);
    for (const [path, kind, target] of [
      ["module.mjs", "static-import", "dep.mjs"],
      ["esm/main.js", "static-import", "dep.mjs"],
      ["esm/.js", "static-import", "dep.mjs"],
      ["esm/.mjs", "static-import", "dep.mjs"],
      ["view.jsx", "static-import", "dep.mjs"],
      ["typed.mts", "static-import", "dep.mjs"],
      ["typed.cts", "require", "dep.cjs"],
      ["plain.cjs", "require", "dep.cjs"],
      ["imported.cjs", "require", "dep.cjs"],
      ["imported.js", "require", "dep.cjs"],
      ...importedDotfiles.map(
        ({ path }) => [path, "static-import", "dep.mjs"] as const,
      ),
    ] as const) {
      const source = files[path]!;
      const line = source.split(/\r?\n/u)[1]!;
      const start = line.indexOf(kind === "require" ? "require" : "import");
      const end = line.indexOf(kind === "require" ? ")" : ";", start) + 1;
      const edges = graph.edges.filter(
        ({ relation, properties, evidence }) =>
          relation === "imports" &&
          properties.kind === kind &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === path,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        properties: {
          resolved_path: path.startsWith("imported.") ? null : target,
          ...(path.startsWith("imported.")
            ? { loader_authority: "candidate" }
            : {}),
        },
        evidence: {
          artifact: {
            available: true,
            sha256: createHash("sha256").update(source).digest("hex"),
          },
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: path,
              start: { line: 2, column: start },
              end: { line: 2, column: end },
            },
          },
        },
      });
    }
    const dotfile = graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties }) =>
          properties.path === "esm/dot-0/.cjs" &&
          properties.text_status !== undefined,
      );
    expect(dotfile).toMatchObject({
      properties: {
        parse_status: "partial",
        analysis_coverage: {
          syntax: { status: "complete", error_count: 0 },
          semantics: { uncertainty: ["conditional-loader"] },
        },
      },
      evidence: {
        limitations: expect.arrayContaining([
          expect.stringContaining("loader invocation is unknown"),
        ]),
      },
    });
    for (const path of ["imported.cjs", "imported.js"]) {
      const observation = graph.nodes
        .flatMap(({ observations }) => observations)
        .find(
          ({ properties }) =>
            properties.path === path && properties.text_status !== undefined,
        );
      expect(observation).toMatchObject({
        properties: {
          parse_status: "partial",
          analysis_coverage: {
            syntax: { status: "complete", error_count: 0 },
            semantics: {
              uncertainty: expect.arrayContaining(["conditional-loader"]),
            },
          },
        },
        evidence: {
          limitations: expect.arrayContaining([
            expect.stringContaining("loader invocation is unknown"),
          ]),
        },
      });
    }
  },
);

cliTest.runIf(process.platform !== "win32")(
  "reference import retains conditional CommonJS imports and module imports",
  async ({ cli }) => {
    const { root, files } = await fixture();
    const output = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
    });
    const subtree = join(root, "esm", "src");
    await writeFixtureFiles(subtree, {
      "main.js": '\uFEFF#!/usr/bin/env node\nimport "./dep.mjs";',
      "dep.mjs": "export const marker=42;",
    });
    const narrowed = await cli.run({
      arguments: ["import-reference-source", subtree, "--json"],
    });
    expect(narrowed.exitCode, narrowed.stderr).toBe(0);
    const partial = historicalSourceGraphSchema.parse(narrowed.json);
    expect(partial.parse_failures).toEqual([]);
    expect(partial.relationships).toContainEqual(
      expect.objectContaining({
        from_path: "main.js",
        to: "dep.mjs",
        kind: "imports",
        parse_state: "partial",
        resolution: "internal",
      }),
    );
    expect(partial.limitations).toContainEqual(
      expect.stringContaining("loader invocation is unknown"),
    );
    expect(output.exitCode, output.stderr).toBe(0);
    const graph = historicalSourceGraphSchema.parse(output.json);
    expect(graph.parse_failures).toMatchObject([{ path: "malformed.cjs" }]);
    for (const [path, parseState] of [
      ["module.mjs", "parsed"],
      ["esm/main.js", "parsed"],
      ["esm/.js", "partial"],
      ["esm/.mjs", "partial"],
      ["view.jsx", "parsed"],
      ["typed.mts", "parsed"],
      ...importedDotfiles.map(({ path }) => [path, "partial"] as const),
    ] as const) {
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          sha256: createHash("sha256").update(files[path]!).digest("hex"),
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "dep.mjs",
          kind: "imports",
          parse_state: parseState,
          resolution: "internal",
        }),
      );
    }
    expect(graph.relationships).toContainEqual(
      expect.objectContaining({
        from_path: "typed.cts",
        to: "dep.cjs",
        kind: "requires",
        parse_state: "parsed",
      }),
    );
    for (const path of ["imported.cjs", "imported.js"]) {
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          sha256: createHash("sha256").update(files[path]!).digest("hex"),
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "./dep.cjs",
          kind: "requires",
          parse_state: "partial",
          resolution: "unknown",
        }),
      );
      expect(graph.limitations).toContainEqual(
        expect.stringContaining(`Source in ${path}`),
      );
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains conditional BOM/hashbang imports when analyzing a package subtree through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-bom-subtree-");
    const source =
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));';
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module" }),
      "src/main.js": source,
      "src/dep.mjs": "export const marker=42;",
    });
    expect(await runNodeJsonControl(root, "src/main.js")).toEqual({
      marker: 42,
    });
    const result = await analyzeJavaScriptDirectory(
      surface,
      cli,
      join(root, "src"),
    );
    expect(result.statistics.parse_failures).toBe(0);
    const properties = result.graph.nodes
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      )
      .find(
        (properties) =>
          properties.path === "main.js" && properties.text_status !== undefined,
      );
    expect(properties).toMatchObject({
      parse_status: "partial",
      analysis_coverage: {
        syntax: { status: "complete", error_count: 0 },
        semantics: { uncertainty: ["conditional-loader"] },
      },
    });
    const edge = result.graph.edges.find(
      ({ relation, evidence }) =>
        relation === "imports" &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === "main.js",
    );
    expect(edge).toMatchObject({
      properties: { kind: "static-import", resolved_path: "dep.mjs" },
      evidence: {
        artifact: {
          available: true,
          sha256: createHash("sha256").update(source).digest("hex"),
        },
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: "main.js",
            start: { line: 2, column: 17 },
            end: { line: 2, column: 50 },
          },
        },
      },
    });
    const sourceObservation = result.graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties }) =>
          properties.path === "main.js" && properties.text_status !== undefined,
      );
    expect(sourceObservation?.evidence.limitations).toContainEqual(
      expect.stringContaining("loader invocation is unknown"),
    );
  },
);
