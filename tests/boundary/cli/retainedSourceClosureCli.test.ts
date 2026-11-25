import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import {
  createEvidence,
  withEvidenceCallerInputPath,
} from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import {
  createAnalysisExecution,
  type AnalysisProvider,
} from "../../../src/ports/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains this CLI invocation's complete source closure when the parent record is unchanged", async () => {
  const root = await createTestTempDirectory("rea-retain-source-closure-");
  const target = join(root, "selected.hop");
  await writeFile(target, "synthetic analysis database");
  const identity = { id: "fixture", name: "Fixture", version: "1" } as const;
  const history = createEvidence(unknownTarget("not-observed"), identity, {
    operation: "health",
    parameters: {},
    result: "project history",
  });
  let callerPath = "./first-project";
  const provider: AnalysisProvider = {
    identity: () => identity,
    capabilities: () => [
      {
        provider: identity,
        operation: "procedure_references",
        available: true,
        reason: null,
        cachePolicy: "live",
        limitations: [],
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
      },
    ],
    resolveAnalysisProfile: async () =>
      ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
    createClient: () => ({
      execute: async () =>
        ok(
          createAnalysisExecution(
            {
              procedure: {
                address: "0x1000",
                name: "selected",
                classification: null,
                body: { available: false as const, reason: "unavailable" },
              },
              direction: "incoming" as const,
              reference_kinds_available: false,
              references: [],
              unresolved_calls: Array.from({ length: 200 }, (_, index) => ({
                address: `0x${(0x1010 + index).toString(16)}`,
                reason: "unknown target",
              })),
            },
            identity,
            {
              sourceEvidence: [
                withEvidenceCallerInputPath(history, callerPath),
              ],
            },
          ),
        ),
      close: async () => ok(null),
    }),
  };
  const createSession = () => createTestBinarySession(provider);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: createSession,
    createNativeDispatchBinarySession: createSession,
    createArtifactBinarySession: createSession,
    createNativeBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  const environment = {
    HOME: root,
    XDG_CACHE_HOME: root,
    REA_AGENT_RESULT_BUDGET_BYTES: "4096",
  };
  const cli = createCliShell({
    selectedEnvironment: environment,
    registrations: [],
  });
  registerCoreNativeCommands(
    cli,
    pino({ enabled: false }),
    (path, operation, args, options) =>
      runDirectAnalysis(dependencies, path, operation, args, options),
  );
  const run = async (output?: string) => {
    let stdout = "";
    let exitCode = 0;
    await cli.serve(
      [
        "procedure-references",
        target,
        "selected",
        "--provider",
        "fixture",
        "--direction",
        "incoming",
        "--json",
        ...(output === undefined
          ? []
          : ["--detail", "complete", "--evidence_output", output]),
      ],
      {
        env: environment,
        stdout: (text) => {
          stdout += text;
        },
        exit: (code) => {
          exitCode = code;
        },
      },
    );
    expect(exitCode, stdout).toBe(0);
    const parsed = JSON.parse(stdout);
    if (output === undefined)
      expect(parsed, stdout).toHaveProperty("evidence_bundle.path");
    return parsed as {
      evidence_bundle: { path: string; record_sha256: string };
      delivery: { evidence_id: string };
    };
  };
  const sourcePath = async (path: string) =>
    parseEvidenceBundle(JSON.parse(await readFile(path, "utf8"))).records.find(
      (record) => record.evidence_id === history.evidence_id,
    )?.caller_input_path;
  const first = await run();
  expect(await sourcePath(first.evidence_bundle.path)).toBe(callerPath);
  callerPath = "./second-project";
  const explicit = join(root, "explicit-second.json");
  await run(explicit);
  expect(await sourcePath(explicit)).toBe(callerPath);
  const second = await run();
  expect(second.delivery.evidence_id).toBe(first.delivery.evidence_id);
  expect(second.evidence_bundle.record_sha256).toBe(
    first.evidence_bundle.record_sha256,
  );
  expect(await sourcePath(second.evidence_bundle.path)).toBe(callerPath);
  expect(second.evidence_bundle.path).not.toBe(first.evidence_bundle.path);
  const repeat = await run();
  expect(repeat.evidence_bundle.path).toBe(second.evidence_bundle.path);
});
