import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT, PETOS } from "./config.js";
import { PetosBleClient } from "./ble-client.js";
import { packCodexPet } from "./rle-pack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const packedDir = path.join(__dirname, "..", "packed");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const ble = new PetosBleClient();
const logs = [];

function log(line) {
  const item = { at: new Date().toISOString(), line };
  logs.push(item);
  while (logs.length > 200) logs.shift();
  console.log(`[petos] ${line}`);
  const message = JSON.stringify({ type: "log", item });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function asyncRoute(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (error) {
      log(`error: ${error.message}`);
      res.status(500).json({ ok: false, error: error.message, status: ble.status() });
    }
  };
}

ble.on("log", log);

app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/api/status", asyncRoute(async () => ({ ok: true, petos: PETOS, logs, status: ble.status() })));
app.get("/api/rle/packages", asyncRoute(async () => {
  const packages = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".idxrle")) {
        const stat = await fs.stat(full);
        packages.push({
          name: entry.name,
          file: full,
          relative: path.relative(packedDir, full),
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  }
  await walk(packedDir);
  packages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { ok: true, packages };
}));
app.post("/api/scan", asyncRoute(async (req) => ({ ok: true, devices: await ble.scan(req.body || {}) })));
app.post("/api/connect", asyncRoute(async (req) => ({ ok: true, status: await ble.connect(req.body || {}) })));
app.post("/api/disconnect", asyncRoute(async () => ({ ok: true, status: await ble.disconnect() })));
app.post("/api/send", asyncRoute(async (req) => ble.sendJson(req.body)));
app.post("/api/frame/:frame", asyncRoute(async (req) => ble.sendJson({ cmd: "pet.frame", value: Number(req.params.frame) })));
app.post("/api/action/:action", asyncRoute(async (req) => ble.sendJson({ cmd: "pet.action", value: req.params.action })));
app.post("/api/rle/upload", express.raw({ type: "application/octet-stream", limit: "2mb" }), asyncRoute(async (req) => {
  let lastPct = -1;
  return ble.uploadRle(req.body, {
    chunkSize: Number(req.query.chunkSize || 160),
    delayMs: Number(req.query.delayMs || 10),
    onProgress: ({ sent, total, percent }) => {
      const pct = Math.floor(percent * 100);
      if (pct >= lastPct + 5 || sent === total) {
        lastPct = pct;
        log(`rle upload ${pct}% ${sent}/${total}`);
      }
    },
  });
}));
app.post("/api/rle/pack", asyncRoute(async (req) => {
  const { name, colors = 24, size = 200, includeRuns = false } = req.body || {};
  const result = await packCodexPet({ name, colors, size, includeRuns, outDir: packedDir });
  log(`packed ${result.name} ${result.frames} frames ${result.bytes} bytes -> ${result.file}`);
  return result;
}));
app.post("/api/rle/pack-upload", asyncRoute(async (req) => {
  const { name, colors = 24, size = 200, includeRuns = false, chunkSize = 160, delayMs = 10 } = req.body || {};
  const packed = await packCodexPet({ name, colors, size, includeRuns, outDir: packedDir });
  log(`packed ${packed.name} ${packed.frames} frames ${packed.bytes} bytes -> ${packed.file}`);
  const data = await fs.readFile(packed.file);
  let lastPct = -1;
  const upload = await ble.uploadRle(data, {
    chunkSize: Number(chunkSize),
    delayMs: Number(delayMs),
    onProgress: ({ sent, total, percent }) => {
      const pct = Math.floor(percent * 100);
      if (pct >= lastPct + 5 || sent === total) {
        lastPct = pct;
        log(`rle upload ${pct}% ${sent}/${total}`);
      }
    },
  });
  return { ok: true, packed, upload };
}));
app.post("/api/watch/text", asyncRoute(async (req) => {
  const { title = "PetOS", text = "" } = req.body || {};
  return ble.sendJson({ cmd: "watch.text", title, text });
}));

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", logs, status: ble.status(), petos: PETOS }));
});

server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  log(`gateway listening http://127.0.0.1:${DEFAULT_PORT}`);
  log(`target BLE name=${PETOS.deviceName}`);
});
