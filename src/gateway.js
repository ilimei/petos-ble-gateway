import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT, PETOS } from "./config.js";
import { PetosBleClient } from "./ble-client.js";
import { packCodexPet } from "./rle-pack.js";
import { assertCapability, validatePetPackageForProfile } from "./device-capabilities.js";
import { inspectIdxRleBuffer, inspectIdxRleFile } from "./idxrle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const packedDir = path.join(__dirname, "..", "packed");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const ble = new PetosBleClient();
const logs = [];
let uploadInProgress = false;

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

function broadcastProgress({ transport, sent, total, percent }) {
  const message = JSON.stringify({
    type: "progress",
    transport,
    sent,
    total,
    percent: Math.floor(percent * 100),
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function broadcastStatus() {
  const message = JSON.stringify({ type: "status", uploadInProgress: effectiveUploadInProgress(), status: ble.status() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function effectiveUploadInProgress() {
  return uploadInProgress || Boolean(ble.status().watch?.upload?.active);
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

async function withUploadLock(fn) {
  if (effectiveUploadInProgress()) throw new Error("upload already in progress");
  uploadInProgress = true;
  broadcastStatus();
  try {
    return await fn();
  } finally {
    uploadInProgress = false;
    broadcastStatus();
  }
}

ble.on("log", log);
ble.on("watchMessage", broadcastStatus);

app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));
app.use("/packed", express.static(packedDir));

function currentProfile() {
  return ble.status().profile;
}

async function connectedProfile() {
  const status = ble.status();
  if (status.connected) return status.profile;
  return (await ble.connect()).profile;
}

function assertActionSupported(profile, action) {
  if (!profile.actions.includes(action)) {
    throw new Error(`${profile.label} does not support pet action ${action}`);
  }
}

function assertPackageSupported(meta, profile) {
  assertCapability(profile, "rleUpload");
  const validation = validatePetPackageForProfile(meta, profile);
  if (!validation.ok) {
    throw new Error(`RLE package is not compatible with ${profile.label}: ${validation.issues.join("; ")}`);
  }
}

function currentWifiTarget() {
  const wifi = ble.status().wifi;
  if (!wifi?.connected || !wifi.ip) throw new Error("watch WiFi is not connected; send WiFi config first");
  return { ip: wifi.ip, port: Number(wifi.port || 8788), rlePort: Number(wifi.rlePort || 8789) };
}

async function verifyWifiTarget(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch(`http://${target.ip}:${target.port}/status`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.connected) throw new Error("watch WiFi status says disconnected");
    return json;
  } catch (error) {
    throw new Error(`watch WiFi target ${target.ip}:${target.port} is not reachable: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function createSocketLineReader(socket) {
  let buffer = "";
  const waiters = [];
  let closed = false;
  let socketError = null;

  const pump = () => {
    while (waiters.length) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      waiters.shift().resolve(line);
    }
    if ((closed || socketError) && waiters.length) {
      const error = socketError || new Error("WiFi TCP socket closed");
      while (waiters.length) waiters.shift().reject(error);
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    pump();
  });
  socket.on("error", (error) => {
    socketError = error;
    pump();
  });
  socket.on("close", () => {
    closed = true;
    pump();
  });

  return function readLine(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((item) => item.resolve === wrappedResolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("WiFi TCP response timeout"));
      }, timeoutMs);
      const wrappedResolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      const wrappedReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      waiters.push({ resolve: wrappedResolve, reject: wrappedReject });
      pump();
    });
  };
}

function writeSocket(socket, data) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    if (socket.write(data)) onDrain();
    else socket.once("drain", onDrain);
  });
}

async function uploadRleOverWifiTcp(data, { slot = null, chunkSize = 32 * 1024, onProgress } = {}) {
  const target = currentWifiTarget();
  await verifyWifiTarget(target);
  const socket = net.createConnection({ host: target.ip, port: target.rlePort });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const readLine = createSocketLineReader(socket);
  const header = Buffer.alloc(16);
  header.write("PTOSRLE1", 0, "ascii");
  header.writeUInt32LE(data.length, 8);
  header.writeUInt8(slot === null || slot === undefined || slot === "" ? 255 : Number(slot), 12);
  await writeSocket(socket, header);
  const ready = await readLine();
  if (!ready.startsWith("READY")) throw new Error(`WiFi TCP begin failed: ${ready}`);
  let confirmed = 0;
  while (true) {
    const line = await readLine(30000);
    if (line.startsWith("OK")) break;
    if (line.startsWith("ERR")) throw new Error(line);
    const match = line.match(/^NEXT\s+(\d+)\s+(\d+)/);
    if (!match) throw new Error(`unexpected WiFi TCP response: ${line}`);
    const offset = Number(match[1]);
    const size = Math.min(Number(match[2]), chunkSize);
    if (offset !== confirmed) throw new Error(`unexpected WiFi TCP offset ${offset}, expected ${confirmed}`);
    const payload = data.subarray(offset, Math.min(offset + size, data.length));
    await writeSocket(socket, payload);
    confirmed = offset + payload.length;
    onProgress?.({ sent: confirmed, total: data.length, percent: confirmed / data.length });
  }
  socket.end();
  return { ok: true, transport: "wifi-tcp", bytes: data.length, target };
}

async function uploadRleOverWifiHttp(data, { slot = null, chunkSize = 16 * 1024, onProgress } = {}) {
  const target = currentWifiTarget();
  const base = `http://${target.ip}:${target.port}`;
  const beginUrl = new URL(`${base}/rle/begin`);
  beginUrl.searchParams.set("size", String(data.length));
  if (slot !== null && slot !== undefined && slot !== "") beginUrl.searchParams.set("slot", String(slot));
  let res = await fetch(beginUrl, { method: "POST" });
  if (!res.ok) throw new Error(`WiFi begin failed: ${res.status} ${await res.text()}`);
  let sent = 0;
  while (sent < data.length) {
    const payload = data.subarray(sent, Math.min(sent + chunkSize, data.length));
    const chunkUrl = new URL(`${base}/rle/chunk`);
    chunkUrl.searchParams.set("offset", String(sent));
    res = await fetch(chunkUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: payload.toString("base64"),
    });
    if (!res.ok) throw new Error(`WiFi chunk failed at ${sent}: ${res.status} ${await res.text()}`);
    sent += payload.length;
    onProgress?.({ sent, total: data.length, percent: sent / data.length });
  }
  res = await fetch(`${base}/rle/end`, { method: "POST" });
  if (!res.ok) throw new Error(`WiFi end failed: ${res.status} ${await res.text()}`);
  return { ok: true, transport: "wifi", bytes: data.length, target };
}

async function uploadRleOverWifi(data, options = {}) {
  return uploadRleOverWifiTcp(data, options);
}

function packDefaultsFromProfile(profile, body = {}) {
  const pet = profile.pet;
  const size = Number(body.size || pet.defaultSize);
  const colors = Number(body.colors || pet.defaultColors);
  if (size > pet.maxSize) throw new Error(`${profile.label} supports pet size up to ${pet.maxSize}, got ${size}`);
  if (colors > pet.maxColors) throw new Error(`${profile.label} supports up to ${pet.maxColors} colors, got ${colors}`);
  return { size, colors };
}

function encodePathSegments(value) {
  return value.split(path.sep).map(encodeURIComponent).join("/");
}

async function findPreviewForPackage(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, ".idxrle");
  const parts = base.split("_");
  const size = parts.pop();
  const suffix = parts.pop();
  const candidates = [
    path.join(dir, `frames_${size}_${suffix}`, "frame_000.png"),
    path.join(dir, "frames_200_watch-no-lr", "frame_000.png"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return `/packed/${encodePathSegments(path.relative(packedDir, candidate))}`;
    } catch {
      // Keep looking for a sibling frame directory below.
    }
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.filter((x) => x.isDirectory() && x.name.startsWith("frames_")).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(dir, entry.name, "frame_000.png");
      try {
        await fs.access(candidate);
        return `/packed/${encodePathSegments(path.relative(packedDir, candidate))}`;
      } catch {
        // Continue scanning.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolvePackedFile(relative) {
  if (!relative || typeof relative !== "string") throw new Error("file is required");
  const full = path.resolve(packedDir, relative);
  const root = path.resolve(packedDir);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error("file must be inside packed directory");
  if (!full.endsWith(".idxrle")) throw new Error("file must be an .idxrle package");
  await fs.access(full);
  return full;
}

app.get("/api/status", asyncRoute(async () => ({ ok: true, petos: PETOS, logs, uploadInProgress: effectiveUploadInProgress(), status: ble.status() })));
app.get("/api/capabilities", asyncRoute(async () => ({ ok: true, profile: currentProfile() })));
app.get("/api/rle/packages", asyncRoute(async () => {
  const packages = [];
  const profile = currentProfile();
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
        let meta = null;
        let compatibility = { ok: false, issues: ["metadata unavailable"] };
        try {
          meta = await inspectIdxRleFile(full);
          compatibility = validatePetPackageForProfile(meta, profile);
        } catch (error) {
          compatibility = { ok: false, issues: [error.message] };
        }
        packages.push({
          name: entry.name,
          file: full,
          relative: path.relative(packedDir, full),
          previewUrl: await findPreviewForPackage(full),
          bytes: stat.size,
          meta,
          compatibility,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  }
  await walk(packedDir);
  packages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { ok: true, profile, packages };
}));
app.post("/api/scan", asyncRoute(async (req) => ({ ok: true, devices: await ble.scan(req.body || {}) })));
app.post("/api/connect", asyncRoute(async (req) => ({ ok: true, status: await ble.connect(req.body || {}) })));
app.post("/api/disconnect", asyncRoute(async () => ({ ok: true, status: await ble.disconnect() })));
app.post("/api/send", asyncRoute(async (req) => ble.sendJson(req.body)));
app.post("/api/wifi/config", asyncRoute(async (req) => {
  const { ssid, password } = req.body || {};
  if (!ssid) throw new Error("ssid is required");
  return ble.sendJson({ cmd: "wifi.config", ssid, password: password || "" });
}));
app.post("/api/wifi/disconnect", asyncRoute(async () => ble.sendJson({ cmd: "wifi.disconnect" })));
app.post("/api/frame/:frame", asyncRoute(async (req) => {
  assertCapability(await connectedProfile(), "bleJson");
  return ble.sendJson({ cmd: "pet.frame", value: Number(req.params.frame) });
}));
app.post("/api/action/:action", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertActionSupported(profile, req.params.action);
  return ble.sendJson({ cmd: "pet.action", value: req.params.action });
}));
app.post("/api/rle/upload", express.raw({ type: "application/octet-stream", limit: "2mb" }), asyncRoute(async (req) => {
  return withUploadLock(async () => {
  const profile = await connectedProfile();
  const meta = inspectIdxRleBuffer(req.body);
  assertPackageSupported(meta, profile);
  const slot = req.query.slot ?? null;
  let lastPct = -1;
  return ble.uploadRle(req.body, {
    chunkSize: Number(req.query.chunkSize || 160),
    delayMs: Number(req.query.delayMs || 10),
    slot,
    onProgress: ({ sent, total, percent }) => {
      const pct = Math.floor(percent * 100);
      if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          log(`rle upload ${pct}% ${sent}/${total}`);
          broadcastProgress({ transport: "ble", sent, total, percent });
        }
      },
    });
  });
}));
app.post("/api/rle/upload-file", asyncRoute(async (req) => {
  return withUploadLock(async () => {
  const { file, chunkSize = 160, delayMs = 10, slot = null, transport = "ble" } = req.body || {};
  const full = await resolvePackedFile(file);
  const data = await fs.readFile(full);
  const profile = await connectedProfile();
  const meta = inspectIdxRleBuffer(data);
  assertPackageSupported(meta, profile);
  let lastPct = -1;
  log(`upload saved ${path.relative(packedDir, full)} ${data.length} bytes via ${transport}`);
  if (transport === "wifi") {
    return uploadRleOverWifi(data, {
      slot,
      onProgress: ({ sent, total, percent }) => {
        const pct = Math.floor(percent * 100);
        if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          log(`wifi rle upload ${pct}% ${sent}/${total}`);
          broadcastProgress({ transport: "wifi", sent, total, percent });
        }
      },
    });
  }
  return ble.uploadRle(data, {
    chunkSize: Number(chunkSize),
    delayMs: Number(delayMs),
    slot,
    onProgress: ({ sent, total, percent }) => {
      const pct = Math.floor(percent * 100);
      if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          log(`rle upload ${pct}% ${sent}/${total}`);
          broadcastProgress({ transport: "ble", sent, total, percent });
        }
      },
    });
  });
}));
app.post("/api/rle/pack", asyncRoute(async (req) => {
  const profile = currentProfile();
  const { size, colors } = packDefaultsFromProfile(profile, req.body || {});
  const { name, includeRuns = false, force = false } = req.body || {};
  const result = await packCodexPet({ name, colors, size, includeRuns, force, outDir: packedDir });
  log(`${result.cached ? "reused" : "packed"} ${result.name} ${result.frames} frames ${result.bytes} bytes -> ${result.file}`);
  return result;
}));
app.post("/api/rle/pack-upload", asyncRoute(async (req) => {
  return withUploadLock(async () => {
  const profile = await connectedProfile();
  const { size, colors } = packDefaultsFromProfile(profile, req.body || {});
  const { name, includeRuns = false, force = false, chunkSize = 160, delayMs = 10, slot = null, transport = "ble" } = req.body || {};
  const packed = await packCodexPet({ name, colors, size, includeRuns, force, outDir: packedDir });
  log(`${packed.cached ? "reused" : "packed"} ${packed.name} ${packed.frames} frames ${packed.bytes} bytes -> ${packed.file}`);
  const data = await fs.readFile(packed.file);
  assertPackageSupported(inspectIdxRleBuffer(data), profile);
  let lastPct = -1;
  if (transport === "wifi") {
    const upload = await uploadRleOverWifi(data, {
      slot,
      onProgress: ({ sent, total, percent }) => {
        const pct = Math.floor(percent * 100);
        if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          log(`wifi rle upload ${pct}% ${sent}/${total}`);
          broadcastProgress({ transport: "wifi", sent, total, percent });
        }
      },
    });
    return { ok: true, packed, upload };
  }
  const upload = await ble.uploadRle(data, {
    chunkSize: Number(chunkSize),
    delayMs: Number(delayMs),
    slot,
    onProgress: ({ sent, total, percent }) => {
      const pct = Math.floor(percent * 100);
        if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          log(`rle upload ${pct}% ${sent}/${total}`);
          broadcastProgress({ transport: "ble", sent, total, percent });
        }
      },
  });
  return { ok: true, packed, upload };
  });
}));
app.post("/api/watch/text", asyncRoute(async (req) => {
  assertCapability(await connectedProfile(), "watchText");
  const { title = "PetOS", text = "" } = req.body || {};
  return ble.sendJson({ cmd: "watch.text", title, text });
}));
app.post("/api/pet/slot", asyncRoute(async (req) => {
  assertCapability(await connectedProfile(), "rleUpload");
  const value = Number(req.body?.slot ?? req.body?.value ?? 0);
  if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error("pet slot must be 0, 1, or 2");
  return ble.sendJson({ cmd: "pet.slot", value });
}));
app.post("/api/pet/say", asyncRoute(async (req) => {
  assertCapability(await connectedProfile(), "bleJson");
  return ble.sendJson({ cmd: "pet.say", text: String(req.body?.text ?? req.body?.message ?? "") });
}));
app.post("/api/pet/bubble/clear", asyncRoute(async () => {
  assertCapability(await connectedProfile(), "bleJson");
  return ble.sendJson({ cmd: "pet.bubble.clear" });
}));
app.post("/api/tab", asyncRoute(async (req) => {
  assertCapability(await connectedProfile(), "bleJson");
  const value = String(req.body?.tab ?? req.body?.value ?? "pet");
  const allowed = new Set(["pet", "home", "watch", "text", "imu", "sensor", "sounds", "audio", "settings", "setting", "next", "prev", "previous", "0", "1", "2", "3", "4"]);
  if (!allowed.has(value)) throw new Error("tab must be pet, watch, imu, sounds, settings, next, or prev");
  return ble.sendJson({ cmd: "ui.tab", value, animate: req.body?.animate === false ? 0 : 1 });
}));
app.post("/api/audio/play/:name", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertCapability(profile, "sounds");
  const sound = profile.sounds.find((item) => item.name === req.params.name);
  if (!sound) throw new Error(`${profile.label} does not have sound ${req.params.name}`);
  return ble.sendJson({ cmd: "audio.play", name: req.params.name });
}));
app.post("/api/audio/volume", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertCapability(profile, "volume");
  return ble.sendJson({ cmd: "audio.volume", value: Number(req.body?.value ?? req.body?.volume ?? 80) });
}));
app.post("/api/display/brightness", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertCapability(profile, "brightness");
  return ble.sendJson({ cmd: "display.brightness", value: Number(req.body?.value ?? req.body?.brightness ?? 80) });
}));
app.post("/api/display/autorotate", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertCapability(profile, "autoRotate");
  return ble.sendJson({ cmd: "display.autorotate", value: req.body?.enabled === false ? 0 : Number(req.body?.value ?? 1) });
}));
app.post("/api/pet/scale", asyncRoute(async (req) => {
  const profile = await connectedProfile();
  assertCapability(profile, "petScale");
  return ble.sendJson({ cmd: "pet.scale", value: Number(req.body?.value ?? req.body?.scale ?? 100) });
}));

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", logs, uploadInProgress: effectiveUploadInProgress(), status: ble.status(), petos: PETOS }));
});

server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  log(`gateway listening http://127.0.0.1:${DEFAULT_PORT}`);
  log(`target BLE name=${PETOS.deviceName}`);
});
