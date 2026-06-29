import fs from "node:fs/promises";

const HEADER_SIZE = 16;
const ACTION_MAGIC = "PTOSACT1";

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

export function inspectIdxRleBuffer(buffer, { bytes = buffer.length } = {}) {
  if (buffer.length < HEADER_SIZE || buffer.subarray(0, 8).toString("ascii") !== "PTOSIDX1") {
    throw new Error("not a PTOSIDX1 .idxrle package");
  }
  const width = readU16(buffer, 8);
  const height = readU16(buffer, 10);
  const frameCount = readU16(buffer, 12);
  const colorCount = readU16(buffer, 14);
  const paletteStart = HEADER_SIZE;
  const recordsStart = paletteStart + colorCount * 3;
  const blobStart = recordsStart + frameCount * 8;
  if (blobStart > buffer.length) throw new Error("truncated idxrle header");

  let blobEnd = blobStart;
  for (let i = 0; i < frameCount; i += 1) {
    const record = recordsStart + i * 8;
    const offset = readU32(buffer, record);
    const size = readU32(buffer, record + 4);
    blobEnd = Math.max(blobEnd, blobStart + offset + size);
  }
  if (blobEnd > buffer.length) throw new Error("truncated idxrle frame blob");

  const actions = [];
  if (blobEnd + 12 <= buffer.length && buffer.subarray(blobEnd, blobEnd + 8).toString("ascii") === ACTION_MAGIC) {
    const actionCount = readU16(buffer, blobEnd + 8);
    let ptr = blobEnd + 12;
    for (let i = 0; i < actionCount && ptr + 20 <= buffer.length; i += 1) {
      const rawName = buffer.subarray(ptr, ptr + 16);
      const nul = rawName.indexOf(0);
      const name = rawName.subarray(0, nul >= 0 ? nul : rawName.length).toString("ascii");
      const start = readU16(buffer, ptr + 16);
      const count = readU16(buffer, ptr + 18);
      if (name && count > 0) actions.push({ name, start, count });
      ptr += 20;
    }
  }

  return {
    magic: "PTOSIDX1",
    width,
    height,
    frameCount,
    colorCount,
    bytes,
    actions,
  };
}

export async function inspectIdxRleFile(file) {
  const data = await fs.readFile(file);
  return inspectIdxRleBuffer(data, { bytes: data.length });
}
