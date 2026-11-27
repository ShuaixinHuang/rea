import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

import {
  ANDROID_OTA_DEFAULT_BLOCK_SIZE,
  ANDROID_OTA_HEADER_V2_BYTES,
  ANDROID_OTA_MAGIC,
} from "./androidOtaPayload.js";

/** Literal occurrences around the typed fields for protobuf ordering controls. */
interface OtaWireFields {
  readonly leadingFields?: Uint8Array;
  readonly trailingFields?: Uint8Array;
}

export interface AndroidOtaExtentFixture extends OtaWireFields {
  readonly startBlock: number;
  readonly numBlocks: number;
}

export interface AndroidOtaOperationFixture extends OtaWireFields {
  readonly type: number;
  readonly data?: Uint8Array;
  readonly dataOffset?: number;
  readonly dataLength?: number;
  readonly dataHash?: Uint8Array;
  readonly dstExtents?: readonly AndroidOtaExtentFixture[];
  readonly srcExtents?: readonly AndroidOtaExtentFixture[];
}

export interface AndroidOtaPartitionFixture extends OtaWireFields {
  readonly name: string;
  readonly newSize?: number;
  readonly newHash?: Uint8Array;
  readonly oldSize?: number;
  readonly oldHash?: Uint8Array;
  /** Exact occurrences of the singular message, for protobuf merge controls. */
  readonly oldInfoFragments?: readonly AndroidOtaPartitionInfoFixture[];
  readonly newInfoFragments?: readonly AndroidOtaPartitionInfoFixture[];
  readonly version?: string;
  readonly runPostinstall?: boolean;
  readonly postinstallPath?: string;
  readonly filesystemType?: string;
  readonly operations: readonly AndroidOtaOperationFixture[];
  readonly mergeOperations?: number;
  readonly estimateCowSize?: number;
  readonly omitNewHash?: boolean;
}

interface AndroidOtaPartitionInfoFixture extends OtaWireFields {
  readonly size?: number | undefined;
  readonly hash?: Uint8Array | undefined;
}

export interface AndroidOtaGroupFixture extends OtaWireFields {
  readonly name: string;
  readonly size?: number;
  readonly partitionNames: readonly string[];
}

export interface AndroidOtaApexFixture {
  readonly packageName: string;
  readonly version: number;
  readonly isCompressed?: boolean;
  readonly decompressedSize?: number;
}

export interface AndroidOtaPayloadFixture extends OtaWireFields {
  readonly majorVersion?: number;
  readonly minorVersion?: number;
  readonly blockSize?: number;
  readonly maxTimestamp?: number;
  readonly partialUpdate?: boolean;
  readonly securityPatchLevel?: string;
  readonly partitions: readonly AndroidOtaPartitionFixture[];
  readonly groups?: readonly AndroidOtaGroupFixture[];
  readonly snapshotEnabled?: boolean;
  readonly vabcEnabled?: boolean;
  readonly vabcCompressionParam?: string;
  readonly apex?: readonly AndroidOtaApexFixture[];
  readonly metadataSignature?: Uint8Array;
  readonly payloadSignature?: Uint8Array;
  readonly signaturesOffset?: number | null;
  readonly signaturesSize?: number | null;
  readonly truncateTo?: number;
}

export const androidOtaFinalFieldCases = [
  "block_size",
  "minor_version",
  "signature_offset",
  "signature_size",
  "new_partition_size",
  "old_partition_size",
  "cow_size",
  "data_offset",
  "data_length",
  "data_hash",
  "extent_start",
  "extent_count",
  "operation_type",
  "group_size",
  "block_size_uint32",
  "minor_version_uint32",
] as const;

/** One selected field occurrence, placed before or after its canonical value. */
export const finalFieldAndroidOtaPayload = (
  field: (typeof androidOtaFinalFieldCases)[number] | "canonical" | "all",
  placement: "leadingFields" | "trailingFields" = "leadingFields",
): Buffer => {
  const unsafe = 1n << 53n;
  const uint = (number: number, value: bigint) =>
    new BinaryWriter().tag(number, WireType.Varint).uint64(value).finish();
  const selected = (
    name: (typeof androidOtaFinalFieldCases)[number],
    bytes: Uint8Array,
  ) => (field === name || field === "all" ? bytes : new Uint8Array());
  const fields = (...bytes: Uint8Array[]) => ({
    [placement]: Buffer.concat(bytes),
  });
  const data = Buffer.from("DATA");
  const hash = createHash("sha256").update(data).digest();
  const info = (name: "old_partition_size" | "new_partition_size") => {
    const bad = { leadingFields: selected(name, uint(1, unsafe)) };
    const good = { size: 4, hash };
    return [
      ...(placement === "leadingFields" ? [bad, good] : [good, bad]),
      {},
      { hash },
    ];
  };
  return buildAndroidOtaPayload({
    blockSize: 4,
    minorVersion: 0,
    metadataSignature: new Uint8Array(),
    payloadSignature: new Uint8Array(),
    ...fields(
      selected("block_size", uint(3, 0n)),
      selected("minor_version", uint(12, unsafe)),
      selected("signature_offset", uint(4, unsafe)),
      selected("signature_size", uint(5, unsafe)),
      selected("block_size_uint32", uint(3, (1n << 32n) + 4n)),
      selected("minor_version_uint32", uint(12, 1n << 32n)),
    ),
    partitions: [
      {
        name: "system",
        oldInfoFragments: info("old_partition_size"),
        newInfoFragments: info("new_partition_size"),
        estimateCowSize: 4,
        ...fields(selected("cow_size", uint(19, unsafe))),
        operations: [
          {
            type: 0,
            data,
            dataHash: hash,
            ...fields(
              selected("data_offset", uint(2, unsafe)),
              selected("data_length", uint(3, unsafe)),
              selected(
                "data_hash",
                new BinaryWriter()
                  .tag(8, WireType.LengthDelimited)
                  .bytes(Buffer.from("x"))
                  .finish(),
              ),
              selected(
                "operation_type",
                new BinaryWriter().tag(1, WireType.Varint).int32(-1).finish(),
              ),
            ),
            dstExtents: [
              {
                startBlock: 0,
                numBlocks: 1,
                ...fields(
                  selected("extent_start", uint(1, unsafe)),
                  selected("extent_count", uint(2, unsafe)),
                ),
              },
            ],
          },
        ],
      },
    ],
    groups: [
      {
        name: "main",
        size: 4,
        partitionNames: ["system"],
        ...fields(selected("group_size", uint(2, unsafe))),
      },
    ],
  });
};

const encodeExtent = (
  writer: BinaryWriter,
  extent: AndroidOtaExtentFixture,
): void => {
  if (extent.leadingFields !== undefined) writer.raw(extent.leadingFields);
  writer.tag(1, WireType.Varint).uint64(extent.startBlock);
  writer.tag(2, WireType.Varint).uint64(extent.numBlocks);
  if (extent.trailingFields !== undefined) writer.raw(extent.trailingFields);
};

const encodePartitionInfo = (
  writer: BinaryWriter,
  info: AndroidOtaPartitionInfoFixture,
): void => {
  if (info.leadingFields !== undefined) writer.raw(info.leadingFields);
  if (info.size !== undefined) writer.tag(1, WireType.Varint).uint64(info.size);
  if (info.hash !== undefined)
    writer.tag(2, WireType.LengthDelimited).bytes(info.hash);
  if (info.trailingFields !== undefined) writer.raw(info.trailingFields);
};

const extentForData = (
  dataLength: number,
  blockSize: number,
): AndroidOtaExtentFixture => ({
  startBlock: 0,
  numBlocks: Math.max(1, Math.ceil(dataLength / blockSize)),
});

const partitionImage = (
  partition: AndroidOtaPartitionFixture,
  blockSize: number,
): Buffer | undefined => {
  const extractable = partition.operations.every(
    (operation) =>
      operation.type === 0 || operation.type === 6 || operation.type === 14,
  );
  if (!extractable) return undefined;
  const size =
    partition.newSize ??
    partition.operations.reduce((largest, operation) => {
      const stored = operation.data ?? new Uint8Array();
      const dataLength =
        operation.type === 14 && stored.length > 0
          ? zstdDecompressSync(stored).length
          : stored.length;
      const extents =
        operation.dstExtents ??
        (dataLength === 0 ? [] : [extentForData(dataLength, blockSize)]);
      // Size the image so the operation data covers every destination byte;
      // only the final block may be partial.
      let remaining = operation.type === 6 ? Infinity : dataLength;
      let end = 0;
      for (const extent of extents) {
        if (remaining <= 0) break;
        const start = extent.startBlock * blockSize;
        const extentBytes = extent.numBlocks * blockSize;
        end = Math.max(end, start + Math.min(extentBytes, remaining));
        remaining -= extentBytes;
      }
      return Math.max(largest, end);
    }, 0);
  const image = Buffer.alloc(size);
  for (const operation of partition.operations) {
    if (operation.type === 6) continue;
    const stored = operation.data ?? new Uint8Array();
    const data = operation.type === 14 ? zstdDecompressSync(stored) : stored;
    const extents = operation.dstExtents ?? [
      extentForData(data.length || size, blockSize),
    ];
    let cursor = 0;
    for (const extent of extents) {
      const start = extent.startBlock * blockSize;
      if (start >= image.length) continue;
      const length = Math.min(
        extent.numBlocks * blockSize,
        image.length - start,
      );
      const available = Math.min(length, Math.max(0, data.length - cursor));
      if (available > 0)
        image.set(data.subarray(cursor, cursor + available), start);
      cursor += available;
    }
  }
  return image;
};

const encodeOperation = (
  writer: BinaryWriter,
  operation: AndroidOtaOperationFixture,
  dataOffset: number,
  blockSize: number,
): void => {
  if (operation.leadingFields !== undefined)
    writer.raw(operation.leadingFields);
  writer.tag(1, WireType.Varint).int32(operation.type);
  const dataLength = operation.dataLength ?? operation.data?.length ?? 0;
  const offset = operation.dataOffset ?? dataOffset;
  if (dataLength > 0 || operation.dataOffset !== undefined) {
    writer.tag(2, WireType.Varint).uint64(offset);
    writer.tag(3, WireType.Varint).uint64(dataLength);
  }
  for (const extent of operation.srcExtents ?? []) {
    writer.tag(4, WireType.LengthDelimited).fork();
    encodeExtent(writer, extent);
    writer.join();
  }
  const dst =
    operation.dstExtents ??
    (operation.type === 6
      ? [{ startBlock: 0, numBlocks: 1 }]
      : [extentForData(dataLength || 1, blockSize)]);
  for (const extent of dst) {
    writer.tag(6, WireType.LengthDelimited).fork();
    encodeExtent(writer, extent);
    writer.join();
  }
  if (operation.dataHash !== undefined)
    writer.tag(8, WireType.LengthDelimited).bytes(operation.dataHash);
  if (operation.trailingFields !== undefined)
    writer.raw(operation.trailingFields);
};

const encodePartition = (
  writer: BinaryWriter,
  partition: AndroidOtaPartitionFixture,
  blob: { offset: number; chunks: Uint8Array[] },
  blockSize: number,
): void => {
  if (partition.leadingFields !== undefined)
    writer.raw(partition.leadingFields);
  writer.tag(1, WireType.LengthDelimited).string(partition.name);
  if (partition.runPostinstall !== undefined)
    writer.tag(2, WireType.Varint).bool(partition.runPostinstall);
  if (partition.postinstallPath !== undefined)
    writer.tag(3, WireType.LengthDelimited).string(partition.postinstallPath);
  if (partition.filesystemType !== undefined)
    writer.tag(4, WireType.LengthDelimited).string(partition.filesystemType);
  const oldInfos =
    partition.oldInfoFragments ??
    (partition.oldSize !== undefined || partition.oldHash !== undefined
      ? [{ size: partition.oldSize, hash: partition.oldHash }]
      : []);
  for (const info of oldInfos) {
    writer.tag(6, WireType.LengthDelimited).fork();
    encodePartitionInfo(writer, info);
    writer.join();
  }
  const image = partitionImage(partition, blockSize);
  const newSize = partition.newSize ?? image?.length;
  const newHash = partition.omitNewHash
    ? undefined
    : (partition.newHash ??
      (image === undefined
        ? undefined
        : createHash("sha256").update(image).digest()));
  const newInfos =
    partition.newInfoFragments ??
    (newSize !== undefined || newHash !== undefined
      ? [{ size: newSize, hash: newHash }]
      : []);
  for (const info of newInfos) {
    writer.tag(7, WireType.LengthDelimited).fork();
    encodePartitionInfo(writer, info);
    writer.join();
  }
  for (const operation of partition.operations) {
    const data = operation.data;
    const assignedOffset = blob.offset;
    if (
      data !== undefined &&
      data.length > 0 &&
      operation.dataOffset === undefined
    ) {
      blob.chunks.push(data);
      blob.offset += data.length;
    }
    writer.tag(8, WireType.LengthDelimited).fork();
    encodeOperation(
      writer,
      operation,
      operation.dataOffset ?? assignedOffset,
      blockSize,
    );
    writer.join();
  }
  if (partition.version !== undefined)
    writer.tag(17, WireType.LengthDelimited).string(partition.version);
  for (let index = 0; index < (partition.mergeOperations ?? 0); index += 1) {
    writer.tag(18, WireType.LengthDelimited).fork();
    writer.tag(1, WireType.Varint).int32(0);
    writer.join();
  }
  if (partition.estimateCowSize !== undefined)
    writer.tag(19, WireType.Varint).uint64(partition.estimateCowSize);
  if (partition.trailingFields !== undefined)
    writer.raw(partition.trailingFields);
};

const encodeGroup = (
  writer: BinaryWriter,
  group: AndroidOtaGroupFixture,
): void => {
  if (group.leadingFields !== undefined) writer.raw(group.leadingFields);
  writer.tag(1, WireType.LengthDelimited).string(group.name);
  if (group.size !== undefined)
    writer.tag(2, WireType.Varint).uint64(group.size);
  for (const name of group.partitionNames)
    writer.tag(3, WireType.LengthDelimited).string(name);
  if (group.trailingFields !== undefined) writer.raw(group.trailingFields);
};

const encodeApex = (
  writer: BinaryWriter,
  apex: AndroidOtaApexFixture,
): void => {
  writer.tag(1, WireType.LengthDelimited).string(apex.packageName);
  writer.tag(2, WireType.Varint).int64(apex.version);
  if (apex.isCompressed !== undefined)
    writer.tag(3, WireType.Varint).bool(apex.isCompressed);
  if (apex.decompressedSize !== undefined)
    writer.tag(4, WireType.Varint).int64(apex.decompressedSize);
};

const encodeManifest = (
  fixture: AndroidOtaPayloadFixture,
  blob: { offset: number; chunks: Uint8Array[] },
  signaturesOffset: number | null,
  signaturesSize: number | null,
): Uint8Array => {
  const writer = new BinaryWriter();
  if (fixture.leadingFields !== undefined) writer.raw(fixture.leadingFields);
  const blockSize = fixture.blockSize ?? ANDROID_OTA_DEFAULT_BLOCK_SIZE;
  writer.tag(3, WireType.Varint).uint32(blockSize);
  if (signaturesOffset !== null)
    writer.tag(4, WireType.Varint).uint64(signaturesOffset);
  if (signaturesSize !== null)
    writer.tag(5, WireType.Varint).uint64(signaturesSize);
  if (fixture.minorVersion !== undefined)
    writer.tag(12, WireType.Varint).uint32(fixture.minorVersion);
  for (const partition of fixture.partitions) {
    writer.tag(13, WireType.LengthDelimited).fork();
    encodePartition(writer, partition, blob, blockSize);
    writer.join();
  }
  if (fixture.maxTimestamp !== undefined)
    writer.tag(14, WireType.Varint).int64(fixture.maxTimestamp);
  if (
    fixture.groups !== undefined ||
    fixture.snapshotEnabled !== undefined ||
    fixture.vabcEnabled !== undefined ||
    fixture.vabcCompressionParam !== undefined
  ) {
    writer.tag(15, WireType.LengthDelimited).fork();
    for (const group of fixture.groups ?? []) {
      writer.tag(1, WireType.LengthDelimited).fork();
      encodeGroup(writer, group);
      writer.join();
    }
    if (fixture.snapshotEnabled !== undefined)
      writer.tag(2, WireType.Varint).bool(fixture.snapshotEnabled);
    if (fixture.vabcEnabled !== undefined)
      writer.tag(3, WireType.Varint).bool(fixture.vabcEnabled);
    if (fixture.vabcCompressionParam !== undefined)
      writer
        .tag(4, WireType.LengthDelimited)
        .string(fixture.vabcCompressionParam);
    writer.join();
  }
  if (fixture.partialUpdate !== undefined)
    writer.tag(16, WireType.Varint).bool(fixture.partialUpdate);
  for (const apex of fixture.apex ?? []) {
    writer.tag(17, WireType.LengthDelimited).fork();
    encodeApex(writer, apex);
    writer.join();
  }
  if (fixture.securityPatchLevel !== undefined)
    writer.tag(18, WireType.LengthDelimited).string(fixture.securityPatchLevel);
  if (fixture.trailingFields !== undefined) writer.raw(fixture.trailingFields);
  return writer.finish();
};

const encodeSignatures = (
  count = 1,
  payload = Buffer.from("sig"),
): Uint8Array => {
  const writer = new BinaryWriter();
  for (let index = 0; index < count; index += 1) {
    writer.tag(1, WireType.LengthDelimited).fork();
    writer.tag(2, WireType.LengthDelimited).bytes(payload);
    writer.join();
  }
  return writer.finish();
};

/** One Signatures protobuf with a single unsigned blob. */
export const androidOtaSignatureBlob = (
  payload = Buffer.from("sig"),
): Uint8Array => encodeSignatures(1, payload);

export const buildAndroidOtaPayload = (
  fixture: AndroidOtaPayloadFixture,
): Buffer => {
  const major = fixture.majorVersion ?? 2;
  const layout = { offset: 0, chunks: [] as Uint8Array[] };
  const metadataSignature =
    fixture.metadataSignature ?? androidOtaSignatureBlob();
  const payloadSignature =
    fixture.payloadSignature ??
    androidOtaSignatureBlob(Buffer.from("payload-sig"));
  encodeManifest(fixture, layout, 0, payloadSignature.length);
  const data = Buffer.concat(layout.chunks);
  const signaturesOffset =
    fixture.signaturesOffset === undefined
      ? data.length
      : fixture.signaturesOffset;
  const signaturesSize =
    fixture.signaturesSize === undefined
      ? payloadSignature.length
      : fixture.signaturesSize;
  const laidOut = { offset: 0, chunks: [] as Uint8Array[] };
  const manifest = encodeManifest(
    fixture,
    laidOut,
    signaturesOffset,
    signaturesSize,
  );
  if (major === 1) {
    const header = Buffer.alloc(20);
    header.write(ANDROID_OTA_MAGIC, 0, "latin1");
    header.writeBigUInt64BE(1n, 4);
    header.writeBigUInt64BE(BigInt(manifest.length), 12);
    const bytes = Buffer.concat([header, Buffer.from(manifest)]);
    return fixture.truncateTo === undefined
      ? bytes
      : bytes.subarray(0, fixture.truncateTo);
  }
  const header = Buffer.alloc(ANDROID_OTA_HEADER_V2_BYTES);
  header.write(ANDROID_OTA_MAGIC, 0, "latin1");
  header.writeBigUInt64BE(BigInt(major), 4);
  header.writeBigUInt64BE(BigInt(manifest.length), 12);
  header.writeUInt32BE(metadataSignature.length, 20);
  const bytes = Buffer.concat([
    header,
    Buffer.from(manifest),
    Buffer.from(metadataSignature),
    Buffer.concat(laidOut.chunks),
    Buffer.from(payloadSignature),
  ]);
  return fixture.truncateTo === undefined
    ? bytes
    : bytes.subarray(0, fixture.truncateTo);
};

export const fullAndroidOtaPayload = (): Buffer =>
  buildAndroidOtaPayload({
    minorVersion: 0,
    blockSize: 4096,
    maxTimestamp: 1_700_000_000,
    partialUpdate: false,
    securityPatchLevel: "2024-01-05",
    partitions: [
      {
        name: "boot",
        version: "boot-1",
        runPostinstall: false,
        filesystemType: "raw",
        operations: [
          {
            type: 0,
            data: Buffer.from("BOOTIMG"),
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
      {
        name: "system",
        version: "system-1",
        runPostinstall: true,
        postinstallPath: "system/bin/otapreopt_script",
        filesystemType: "ext4",
        newSize: 8192,
        operations: [
          { type: 6, dstExtents: [{ startBlock: 0, numBlocks: 2 }] },
        ],
        mergeOperations: 2,
        estimateCowSize: 4096,
      },
    ],
    groups: [
      {
        name: "super",
        size: 64 * 1024 * 1024,
        partitionNames: ["system"],
      },
    ],
    snapshotEnabled: true,
    vabcEnabled: true,
    vabcCompressionParam: "gz",
    apex: [
      {
        packageName: "com.android.runtime",
        version: 340090000,
        isCompressed: true,
        decompressedSize: 12_000_000,
      },
    ],
  });

export const deltaAndroidOtaPayload = (): Buffer =>
  buildAndroidOtaPayload({
    minorVersion: 4,
    partitions: [
      {
        name: "vendor",
        oldSize: 4096,
        oldHash: createHash("sha256").update("old-vendor").digest(),
        newSize: 4096,
        operations: [
          {
            type: 4,
            srcExtents: [{ startBlock: 0, numBlocks: 1 }],
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
          {
            type: 10,
            data: Buffer.from("brotli-diff"),
            srcExtents: [{ startBlock: 1, numBlocks: 1 }],
            dstExtents: [{ startBlock: 1, numBlocks: 1 }],
          },
        ],
      },
    ],
  });

export const unknownOperationAndroidOtaPayload = (): Buffer =>
  buildAndroidOtaPayload({
    partitions: [
      {
        name: "misc",
        newSize: 4096,
        operations: [
          { type: 99, dstExtents: [{ startBlock: 0, numBlocks: 1 }] },
        ],
      },
    ],
  });

export const v1AndroidOtaPayload = (): Buffer =>
  buildAndroidOtaPayload({
    majorVersion: 1,
    partitions: [
      {
        name: "root",
        operations: [{ type: 0, data: Buffer.from("x") }],
      },
    ],
  });
