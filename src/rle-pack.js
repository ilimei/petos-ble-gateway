import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_PACKER = "/Users/huge/.codex/skills/esp32-c3-round-watch-flash/scripts/petos_frames.py";
const ACTION_ROWS = [
  { name: "idle", row: 0 },
  { name: "run_right", row: 1 },
  { name: "run_left", row: 2 },
  { name: "waving", row: 3 },
  { name: "jumping", row: 4 },
  { name: "failed", row: 5 },
  { name: "waiting", row: 6 },
  { name: "running", row: 7 },
  { name: "review", row: 8 },
];

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr || stdout}`));
    });
  });
}

function safeName(name) {
  return String(name).trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function ensurePetInstalled(name) {
  const petDir = path.join(os.homedir(), ".codex", "pets", name);
  try {
    await fs.access(path.join(petDir, "spritesheet.webp"));
    return petDir;
  } catch {
    await run("npx", ["codex-pets", "add", name], {
      env: {
        HTTP_PROXY: process.env.HTTP_PROXY || "http://127.0.0.1:10808",
        HTTPS_PROXY: process.env.HTTPS_PROXY || "http://127.0.0.1:10808",
        ALL_PROXY: process.env.ALL_PROXY || "socks5://127.0.0.1:10808",
      },
    });
    await fs.access(path.join(petDir, "spritesheet.webp"));
    return petDir;
  }
}

async function extractFrames({ petDir, framesDir, actionsPath, includeRuns, size }) {
  const selectedRows = ACTION_ROWS.filter((x) => includeRuns || (x.name !== "run_right" && x.name !== "run_left"));
  const py = String.raw`
from PIL import Image
from pathlib import Path
import json, sys

pet_dir = Path(sys.argv[1])
frames_dir = Path(sys.argv[2])
actions_path = Path(sys.argv[3])
size = int(sys.argv[4])
selected = json.loads(sys.argv[5])

frames_dir.mkdir(parents=True, exist_ok=True)
for p in frames_dir.glob("frame_*.png"):
    p.unlink()

img = Image.open(pet_dir / "spritesheet.webp").convert("RGBA")
cols, rows = 8, 9
cw, ch = img.width // cols, img.height // rows
actions = []
out_idx = 0
for item in selected:
    row = int(item["row"])
    start = out_idx
    count = 0
    for col in range(cols):
        cell = img.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))
        alpha = cell.getchannel("A")
        bbox = alpha.getbbox()
        if bbox is None:
            continue
        sprite = cell.crop(bbox)
        sprite.thumbnail((size, size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(sprite, ((size - sprite.width) // 2, (size - sprite.height) // 2))
        canvas.save(frames_dir / f"frame_{out_idx:03d}.png")
        out_idx += 1
        count += 1
    if count:
        actions.append({"name": item["name"], "start": start, "count": count})

actions_path.write_text(json.dumps({"actions": actions}, indent=2))
print(json.dumps({"sheet": [img.width, img.height], "cell": [cw, ch], "frames": out_idx, "actions": actions}))
`;
  const { stdout } = await run("python3", [
    "-c",
    py,
    petDir,
    framesDir,
    actionsPath,
    String(size),
    JSON.stringify(selectedRows),
  ]);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function inspectPackage(file) {
  const { stdout } = await run("python3", [SKILL_PACKER, "inspect", file]);
  return stdout.trim();
}

export async function packCodexPet({
  name,
  colors = 24,
  size = 200,
  includeRuns = false,
  outDir = path.join(process.cwd(), "packed"),
} = {}) {
  const petName = safeName(name);
  if (!petName) throw new Error("pet name is required");
  colors = Number(colors || 24);
  size = Number(size || 200);
  if (colors < 2 || colors > 256) throw new Error("colors must be between 2 and 256");
  if (size < 64 || size > 240) throw new Error("size must be between 64 and 240");

  const petDir = await ensurePetInstalled(petName);
  const suffix = includeRuns ? "all" : "watch-no-lr";
  const workDir = path.join(outDir, petName);
  const framesDir = path.join(workDir, `frames_${size}_${suffix}`);
  const actionsPath = path.join(workDir, `actions_${suffix}.json`);
  const outPath = path.join(workDir, `${petName}_${suffix}_${size}_${colors}.idxrle`);
  await fs.mkdir(workDir, { recursive: true });

  const extracted = await extractFrames({ petDir, framesDir, actionsPath, includeRuns, size });
  const { stdout } = await run("python3", [
    SKILL_PACKER,
    "pack-indexed",
    framesDir,
    "--colors",
    String(colors),
    "--actions",
    actionsPath,
    "--out",
    outPath,
  ]);
  const stat = await fs.stat(outPath);
  const inspect = await inspectPackage(outPath);
  return {
    ok: true,
    name: petName,
    file: outPath,
    bytes: stat.size,
    colors,
    size,
    includeRuns,
    frames: extracted.frames,
    actions: extracted.actions,
    packLog: stdout.trim(),
    inspect,
  };
}
