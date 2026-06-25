import { DEFAULT_URL } from "./config.js";
import fs from "node:fs/promises";

const gatewayUrl = process.env.PETOS_GATEWAY_URL || DEFAULT_URL;
let nextId = 1;

const tools = [
  {
    name: "petos_status",
    description: "Get PetOS BLE gateway status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "petos_scan",
    description: "Scan for the PetOS-C3 BLE watch.",
    inputSchema: {
      type: "object",
      properties: { timeoutMs: { type: "number", description: "Scan timeout in milliseconds." } },
    },
  },
  {
    name: "petos_connect",
    description: "Connect the gateway to the PetOS-C3 BLE watch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "petos_send_json",
    description: "Send raw JSON to the PetOS watch BLE characteristic.",
    inputSchema: {
      type: "object",
      properties: { payload: { type: "object", description: "JSON payload to write." } },
      required: ["payload"],
    },
  },
  {
    name: "petos_play_action",
    description: "Play a named Codex pet action.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["idle", "waving", "jumping", "failed", "waiting", "running", "review"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "petos_show_frame",
    description: "Show one fixed Codex pet frame by index.",
    inputSchema: {
      type: "object",
      properties: { frame: { type: "number", minimum: 0, maximum: 40 } },
      required: ["frame"],
    },
  },
  {
    name: "petos_show_text",
    description: "Show multiline text on the watch page. Supports LVGL recolor tags like #22c55e text#.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short page title." },
        text: { type: "string", description: "Multiline text to show on the second page." },
      },
      required: ["text"],
    },
  },
  {
    name: "petos_upload_rle",
    description: "Upload a local PTOSIDX1 .idxrle pet package to the watch over BLE.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Absolute path to the .idxrle package." },
        chunkSize: { type: "number", description: "BLE payload bytes per chunk. Default 160." },
        delayMs: { type: "number", description: "Delay between chunks in milliseconds. Default 10." },
      },
      required: ["file"],
    },
  },
  {
    name: "petos_pack_rle",
    description: "Download a Codex pet and pack it into a watch-ready PTOSIDX1 .idxrle file.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Codex pet name, for example cloud-strife." },
        colors: { type: "number", description: "Palette size. Default 24." },
        size: { type: "number", description: "Frame canvas size. Default 200." },
        includeRuns: { type: "boolean", description: "Include run_right/run_left rows. Default false." },
      },
      required: ["name"],
    },
  },
  {
    name: "petos_pack_upload_pet",
    description: "Pack a Codex pet into .idxrle and upload it to the watch over BLE.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Codex pet name, for example cloud-strife." },
        colors: { type: "number", description: "Palette size. Default 24." },
        size: { type: "number", description: "Frame canvas size. Default 200." },
        includeRuns: { type: "boolean", description: "Include run_right/run_left rows. Default false." },
        chunkSize: { type: "number", description: "BLE payload bytes per chunk. Default 160." },
        delayMs: { type: "number", description: "Delay between chunks in milliseconds. Default 10." },
      },
      required: ["name"],
    },
  },
];

async function request(path, body) {
  const res = await fetch(`${gatewayUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function uploadFile(path, { chunkSize = 160, delayMs = 10 } = {}) {
  const data = await fs.readFile(path);
  const res = await fetch(`${gatewayUrl}/api/rle/upload?chunkSize=${chunkSize}&delayMs=${delayMs}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: data,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function packPet(args = {}) {
  return request("/api/rle/pack", {
    name: args.name,
    colors: args.colors || 24,
    size: args.size || 200,
    includeRuns: Boolean(args.includeRuns),
  });
}

async function packUploadPet(args = {}) {
  return request("/api/rle/pack-upload", {
    name: args.name,
    colors: args.colors || 24,
    size: args.size || 200,
    includeRuns: Boolean(args.includeRuns),
    chunkSize: args.chunkSize || 160,
    delayMs: args.delayMs || 10,
  });
}

async function callTool(name, args = {}) {
  if (name === "petos_status") return request("/api/status");
  if (name === "petos_scan") return request("/api/scan", { timeoutMs: args.timeoutMs || 7000 });
  if (name === "petos_connect") return request("/api/connect", {});
  if (name === "petos_send_json") return request("/api/send", args.payload);
  if (name === "petos_play_action") return request(`/api/action/${encodeURIComponent(args.action)}`, {});
  if (name === "petos_show_frame") return request(`/api/frame/${Number(args.frame)}`, {});
  if (name === "petos_show_text") return request("/api/watch/text", { title: args.title || "PetOS", text: args.text });
  if (name === "petos_upload_rle") return uploadFile(args.file, args);
  if (name === "petos_pack_rle") return packPet(args);
  if (name === "petos_pack_upload_pet") return packUploadPet(args);
  throw new Error(`Unknown tool: ${name}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } })}\n`);
}

async function handle(message) {
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "petos-ble-gateway", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    respond(message.id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    const result = await callTool(message.params.name, message.params.arguments || {});
    respond(message.id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
    return;
  }
  if (message.id !== undefined) fail(message.id, new Error(`Unsupported method: ${message.method}`));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    Promise.resolve()
      .then(() => handle(JSON.parse(line)))
      .catch((error) => {
        try {
          const parsed = JSON.parse(line);
          fail(parsed.id ?? nextId++, error);
        } catch {
          fail(nextId++, error);
        }
      });
  }
});
