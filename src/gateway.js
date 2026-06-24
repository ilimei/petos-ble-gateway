import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DEFAULT_PORT, PETOS } from "./config.js";
import { PetosBleClient } from "./ble-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

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
app.post("/api/scan", asyncRoute(async (req) => ({ ok: true, devices: await ble.scan(req.body || {}) })));
app.post("/api/connect", asyncRoute(async (req) => ({ ok: true, status: await ble.connect(req.body || {}) })));
app.post("/api/disconnect", asyncRoute(async () => ({ ok: true, status: await ble.disconnect() })));
app.post("/api/send", asyncRoute(async (req) => ble.sendJson(req.body)));
app.post("/api/frame/:frame", asyncRoute(async (req) => ble.sendJson({ cmd: "pet.frame", value: Number(req.params.frame) })));
app.post("/api/action/:action", asyncRoute(async (req) => ble.sendJson({ cmd: "pet.action", value: req.params.action })));

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello", logs, status: ble.status(), petos: PETOS }));
});

server.listen(DEFAULT_PORT, "127.0.0.1", () => {
  log(`gateway listening http://127.0.0.1:${DEFAULT_PORT}`);
  log(`target BLE name=${PETOS.deviceName}`);
});
