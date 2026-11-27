import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { expect, it } from "vitest";

import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
} from "../resources/ArtifactReader.js";
import {
  androidOtaFinalFieldCases,
  buildAndroidOtaPayload,
  finalFieldAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../domain/firmware/androidOtaPayload.fixture.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeCarrier = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-android-ota-", name, bytes);

it.each([
  { field: "canonical" as const, placement: "leadingFields" as const },
  ...androidOtaFinalFieldCases.flatMap((field) =>
    (["leadingFields", "trailingFields"] as const).map((placement) => ({
      field,
      placement,
    })),
  ),
])(
  "uses final protobuf values for $field ($placement) through inventory and partition reads",
  async ({ field, placement }) => {
    const bytes = finalFieldAndroidOtaPayload(field, placement);
    const path = await writeCarrier("payload.bin", bytes);
    // uint32 fields retain their low 32 bits even when the wide value is last.
    const validFinal =
      placement === "leadingFields" ||
      field === "minor_version" ||
      field.endsWith("_uint32");
    if (!validFinal) {
      await expect(scanCanonicalArtifactInventory(path)).rejects.toBeInstanceOf(
        ArtifactReaderFailure,
      );
      return;
    }
    const snapshot = await scanCanonicalArtifactInventory(path);
    expect(
      snapshot.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      block_size: 4,
      minor_version: 0,
      payload_kind: "full",
      signatures_offset: 4,
      signatures_size: 0,
      dynamic_partition_groups: [
        { name: "main", size: 4, partition_names: ["system"] },
      ],
    });
    const hash = createHash("sha256").update("DATA").digest("hex");
    expect(
      snapshot.occurrences.find((row) => row.logical_path === "system.img"),
    ).toMatchObject({
      hash_status: "verified",
      format_metadata: {
        new_partition_info: { size: 4, hash_hex: hash },
        old_partition_info: { size: 4, hash_hex: hash },
        estimate_cow_size: 4,
      },
    });
    const reader = new AndroidOtaPayloadArtifactReader(path);
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const partition = entries.find((entry) => entry.path === "system.img");
      expect(
        (await buffer(await reader.open(partition!))).equals(
          Buffer.from("DATA"),
        ),
      ).toBe(true);
    } finally {
      await reader.close();
    }
  },
);

it("distinguishes supported OTA payload bytes from opaque ZIP members", async () => {
  const archive = zipArchive([
    { name: "update.bin", data: fullAndroidOtaPayload(), method: 0 },
    { name: "old/payload.bin", data: v1AndroidOtaPayload(), method: 0 },
    { name: "notes/payload.bin", data: Buffer.from("nope"), method: 0 },
  ]);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("update.zip", archive),
  );
  expect(snapshot.manifest.root_format).toBe("zip");
  for (const [logical_path, artifact_format, artifact_kind] of [
    ["update.bin", "android-ota-payload", "container"],
    ["old/payload.bin", "file", "resource"],
    ["notes/payload.bin", "file", "resource"],
  ]) {
    expect(
      snapshot.occurrences.find((row) => row.logical_path === logical_path),
    ).toMatchObject({
      artifact_format,
      artifact_kind,
    });
  }
  expect(
    snapshot.occurrences.map(({ logical_path }) => logical_path).sort(),
  ).toEqual([".", "notes/payload.bin", "old/payload.bin", "update.bin"]);
});

it.each([
  ["outside", 1_700_000_000n, 1n << 53n, null],
  ["within", 1n << 53n, 1_700_000_000n, 1_700_000_000],
] as const)(
  "reports the last OTA timestamp when it is %s the exact integer range",
  async (_label, first, last, expected) => {
    const manifest = new BinaryWriter()
      .tag(14, WireType.Varint)
      .int64(first)
      .tag(14, WireType.Varint)
      .int64(last)
      .finish();
    const header = Buffer.alloc(24);
    header.write("CrAU");
    header.writeBigUInt64BE(2n, 4);
    header.writeBigUInt64BE(BigInt(manifest.length), 12);
    const snapshot = await scanCanonicalArtifactInventory(
      await writeCarrier("payload.bin", Buffer.concat([header, manifest])),
    );
    expect(
      snapshot.occurrences.find(({ logical_path }) => logical_path === "."),
    ).toMatchObject({
      format_metadata: { kind: "android-ota-payload", max_timestamp: expected },
    });
    expect(
      snapshot.limitations.some((note) => note.includes("max_timestamp")),
    ).toBe(expected === null);
  },
);

it("keeps the manifest when a partition exceeds the extraction limit", async () => {
  const path = await writeCarrier(
    "large.bin",
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          operations: [{ type: 0, data: Buffer.from("KERNEL") }],
        },
        {
          name: "system",
          newSize: 64 * 1024 * 1024,
          newHash: Buffer.alloc(32, 0xaa),
          operations: [
            { type: 6, dstExtents: [{ startBlock: 0, numBlocks: 1 }] },
          ],
        },
      ],
    }),
  );
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const system = entries.find((entry) => entry.path === "system.img");
    await expect(reader.open(system!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
  } finally {
    await reader.close();
  }
  const kept = await scanCanonicalArtifactInventory(path);
  expect(kept.manifest.root_format).toBe("android-ota-payload");
  expect(
    kept.occurrences.find((row) => row.logical_path === ".")?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    partitions: [{ name: "boot" }, { name: "system" }],
  });
  expect(
    kept.occurrences.find((row) => row.logical_path === "system.img")
      ?.hash_status,
  ).toBe("unavailable");
});

it("keeps partition inventory when the blob is truncated", async () => {
  const full = fullAndroidOtaPayload();
  const metadataBytes =
    Number(full.readBigUInt64BE(12)) + full.readUInt32BE(20);
  const truncated = full.subarray(0, 24 + metadataBytes + 1);
  const path = await writeCarrier("truncated.bin", truncated);
  const reader = new AndroidOtaPayloadArtifactReader(path);
  let readerCoverage:
    | { readonly status: string; readonly limitations: readonly string[] }
    | undefined;
  try {
    for await (const _entry of reader.entries(undefined, {
      onCoverage: (coverage) => {
        readerCoverage = coverage;
      },
    })) {
      // Inspect traversal coverage reported directly by entries().
    }
  } finally {
    await reader.close();
  }
  expect(readerCoverage?.status).toBe("unknown");
  expect(readerCoverage?.limitations.join(" ")).toContain("truncated");
  const kept = await scanCanonicalArtifactInventory(path);
  expect(kept.manifest.root_format).toBe("android-ota-payload");
  expect(kept.coverage.status).toBe("unknown");
  expect(kept.limitations.join(" ")).toContain("truncated");
  expect(
    kept.occurrences.find((row) => row.logical_path === ".")?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    blob_truncated: true,
    partitions: [{ name: "boot" }, { name: "system" }],
  });
  expect(
    kept.occurrences.filter(({ logical_path }) => logical_path !== "."),
  ).toMatchObject([
    { logical_path: "boot.img", hash_status: "unavailable" },
    { logical_path: "system.img", hash_status: "verified" },
  ]);
});

it("reports unknown coverage when optional trailing payloadSignature is truncated", async () => {
  const signature = Buffer.from(
    new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .bytes(new Uint8Array([0xaa, 0xbb]))
      .finish(),
  );
  const full = buildAndroidOtaPayload({
    partitions: [
      { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
    ],
    payloadSignature: signature,
  });
  const completePath = await writeCarrier("complete-trailing-sig.bin", full);
  const truncatedPath = await writeCarrier(
    "truncated-trailing-sig.bin",
    full.subarray(0, full.length - 1),
  );

  for (const [path, expectedStatus, expectedTruncated, expectedSigCount] of [
    [completePath, "complete", false, 1],
    [truncatedPath, "unknown", true, null],
  ] as const) {
    const reader = new AndroidOtaPayloadArtifactReader(path);
    let readerCoverage:
      | { readonly status: string; readonly limitations: readonly string[] }
      | undefined;
    try {
      for await (const _entry of reader.entries(undefined, {
        onCoverage: (coverage) => {
          readerCoverage = coverage;
        },
      })) {
        // Inspect traversal coverage before opening any partition member.
      }
    } finally {
      await reader.close();
    }
    expect(readerCoverage?.status).toBe(expectedStatus);
    expect(readerCoverage?.limitations.join(" ").includes("truncated")).toBe(
      expectedTruncated,
    );

    const snapshot = await scanCanonicalArtifactInventory(path);
    expect(snapshot.manifest.root_format).toBe("android-ota-payload");
    expect(snapshot.coverage.status).toBe(expectedStatus);
    expect(snapshot.limitations.join(" ").includes("truncated")).toBe(
      expectedTruncated,
    );
    expect(
      snapshot.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-ota-payload",
      blob_truncated: expectedTruncated,
      payload_signature_count: expectedSigCount,
      payload_signature_blob_size: signature.length,
    });
    expect(
      snapshot.occurrences.find((row) => row.logical_path === "boot.img"),
    ).toMatchObject({ hash_status: "verified" });
  }
});

it("checks the stored OTA operation bytes when a partition hash is absent", async () => {
  const original = Buffer.from("BOOT");
  const dataHash = createHash("sha256").update(original).digest();
  for (const data of [original, Buffer.from("BOAT")]) {
    const path = await writeCarrier(
      "payload.bin",
      buildAndroidOtaPayload({
        partitions: [
          {
            name: "boot",
            omitNewHash: true,
            operations: [{ type: 0, data, dataHash }],
          },
        ],
      }),
    );
    const reader = new AndroidOtaPayloadArtifactReader(path);
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (entry === undefined) throw new Error("Missing boot partition");
      expect(entry).toMatchObject({
        path: "boot.img",
        declaredIntegrity: null,
      });
      const opened = reader.open(entry).then(buffer);
      if (data === original) {
        expect((await opened).equals(original)).toBe(true);
      } else {
        await expect(opened).rejects.toMatchObject({
          reason: "integrity",
          integrityCheck: "declared-digest",
          message: expect.stringContaining("operation 0"),
        });
      }
    } finally {
      await reader.close();
    }
  }
});

it("retains payload header and partitions when optional trailing payloadSignature parsing fails", async () => {
  const path = await writeCarrier(
    "bad-trailing-sig.bin",
    buildAndroidOtaPayload({
      partitions: [
        { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
      ],
      // Invalid protobuf wire type 7 in optional trailing payload signature blob.
      payloadSignature: Buffer.from([0x0f, 0xff, 0xff, 0xff]),
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-ota-payload");
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "Optional trailing payload signature could not be parsed",
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    payload_signature_count: null,
    partitions: [{ name: "boot" }],
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "boot.img"),
  ).toMatchObject({ hash_status: "verified" });
});

it("refuses trailing payloadSignature blobs that exceed the fixed signature count limit", async () => {
  const writer = new BinaryWriter();
  for (let index = 0; index < 65; index += 1)
    writer.tag(1, WireType.LengthDelimited).bytes(new Uint8Array([index]));
  const path = await writeCarrier(
    "too-many-trailing-sigs.bin",
    buildAndroidOtaPayload({
      partitions: [
        { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
      ],
      payloadSignature: Buffer.from(writer.finish()),
    }),
  );
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        // Expect refusal during preparation before yielding entries.
      }
    }).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      message: expect.stringContaining("signature count"),
    });
  } finally {
    await reader.close();
  }
  await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow(
    /signature count exceeds the fixed 64-signature ceiling/u,
  );
});
