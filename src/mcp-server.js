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
    description: "Scan for PetOS BLE watches such as PetOS-C3 or PetOS-S3.",
    inputSchema: {
      type: "object",
      properties: { timeoutMs: { type: "number", description: "Scan timeout in milliseconds." } },
    },
  },
  {
    name: "petos_connect",
    description: "Connect the gateway to a PetOS BLE watch and return detected device capabilities.",
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
    name: "petos_select_pet",
    description: "Switch the active pet slot on the watch. Slots are zero-based: 0, 1, 2.",
    inputSchema: {
      type: "object",
      properties: { slot: { type: "number", minimum: 0, maximum: 2 } },
      required: ["slot"],
    },
  },
  {
    name: "petos_say",
    description: "Show a speech bubble on the pet page. Pass an empty string to hide it.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "petos_clear_bubble",
    description: "Hide the pet speech bubble.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "petos_open_tab",
    description: "Switch the watch UI tab. Supports pet, watch, imu, sounds, settings, next, and prev.",
    inputSchema: {
      type: "object",
      properties: {
        tab: {
          type: "string",
          enum: ["pet", "watch", "imu", "sounds", "settings", "next", "prev"],
        },
        animate: { type: "boolean" },
      },
      required: ["tab"],
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
    description: "Upload a local PTOSIDX1 .idxrle pet package to the watch over BLE. The gateway rejects packages incompatible with the connected device.",
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
    description: "Download a Codex pet and pack it into a watch-ready PTOSIDX1 .idxrle file. Defaults follow the connected device profile.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Codex pet name, for example cloud-strife." },
        colors: { type: "number", description: "Palette size. Default follows connected device." },
        size: { type: "number", description: "Frame canvas size. Default follows connected device." },
        includeRuns: { type: "boolean", description: "Include run_right/run_left rows. Default false." },
        force: { type: "boolean", description: "Rebuild even when a matching .idxrle already exists. Default false." },
      },
      required: ["name"],
    },
  },
  {
    name: "petos_pack_upload_pet",
    description: "Pack a Codex pet into .idxrle and upload it to the watch over BLE. Defaults and validation follow the connected device profile.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Codex pet name, for example cloud-strife." },
        colors: { type: "number", description: "Palette size. Default follows connected device." },
        size: { type: "number", description: "Frame canvas size. Default follows connected device." },
        includeRuns: { type: "boolean", description: "Include run_right/run_left rows. Default false." },
        force: { type: "boolean", description: "Rebuild even when a matching .idxrle already exists. Default false." },
        chunkSize: { type: "number", description: "BLE payload bytes per chunk. Default 160." },
        delayMs: { type: "number", description: "Delay between chunks in milliseconds. Default 10." },
      },
      required: ["name"],
    },
  },
  {
    name: "petos_play_sound",
    description: "Play a named bundled sound on devices with audio support.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: ["woyaoyanpai", "paimeiyouwenti", "geiwocapixie", "meizuo"],
        },
      },
      required: ["name"],
    },
  },
  {
    name: "petos_set_volume",
    description: "Set speaker volume on devices with audio support.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number", minimum: 0, maximum: 100 } },
      required: ["value"],
    },
  },
  {
    name: "petos_set_brightness",
    description: "Set backlight brightness on devices with brightness support.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number", minimum: 5, maximum: 100 } },
      required: ["value"],
    },
  },
  {
    name: "petos_set_auto_rotate",
    description: "Enable or disable IMU-driven screen rotation on devices that support it.",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  {
    name: "petos_set_pet_scale",
    description: "Set pet render scale percent on devices that support it.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number", minimum: 50, maximum: 220 } },
      required: ["value"],
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
    colors: args.colors,
    size: args.size,
    includeRuns: Boolean(args.includeRuns),
    force: Boolean(args.force),
  });
}

async function packUploadPet(args = {}) {
  return request("/api/rle/pack-upload", {
    name: args.name,
    colors: args.colors,
    size: args.size,
    includeRuns: Boolean(args.includeRuns),
    force: Boolean(args.force),
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
  if (name === "petos_select_pet") return request("/api/pet/slot", { value: args.slot });
  if (name === "petos_say") return request("/api/pet/say", { text: args.text });
  if (name === "petos_clear_bubble") return request("/api/pet/bubble/clear", {});
  if (name === "petos_open_tab") return request("/api/tab", { value: args.tab, animate: args.animate !== false });
  if (name === "petos_show_frame") return request(`/api/frame/${Number(args.frame)}`, {});
  if (name === "petos_show_text") return request("/api/watch/text", { title: args.title || "PetOS", text: args.text });
  if (name === "petos_upload_rle") return uploadFile(args.file, args);
  if (name === "petos_pack_rle") return packPet(args);
  if (name === "petos_pack_upload_pet") return packUploadPet(args);
  if (name === "petos_play_sound") return request(`/api/audio/play/${encodeURIComponent(args.name)}`, {});
  if (name === "petos_set_volume") return request("/api/audio/volume", { value: args.value });
  if (name === "petos_set_brightness") return request("/api/display/brightness", { value: args.value });
  if (name === "petos_set_auto_rotate") return request("/api/display/autorotate", { enabled: Boolean(args.enabled) });
  if (name === "petos_set_pet_scale") return request("/api/pet/scale", { value: args.value });
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
