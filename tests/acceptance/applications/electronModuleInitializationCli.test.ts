import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves hoisted Electron initialization uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-initialization-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: "early.cjs" }),
      "early.cjs": `
        const { BrowserWindow } = require("electron");
        createWindow();
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        require("./late.cjs");
        throw new Error("must not execute source");
      `,
      "late.cjs": `
        const { BrowserWindow } = require("electron");
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        const webPreferences = { nodeIntegration: true };
        createWindow();
        throw new Error("must not execute source");
      `,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(2);
    const observations = windows.flatMap(({ observations }) => observations);
    const inSource = (source: string) =>
      observations.filter(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
    expect(inSource("early.cjs")).toHaveLength(1);
    expect(inSource("early.cjs")[0]?.properties).toMatchObject({
      web_preferences_status: "dynamic",
      web_preferences: [],
    });
    expect(inSource("late.cjs")).toHaveLength(1);
    expect(inSource("late.cjs")[0]?.properties).toMatchObject({
      web_preferences_status: "object-literal",
      web_preferences: [
        { name: "nodeIntegration", value: { status: "literal", value: true } },
      ],
    });
  },
);
