# PetOS BLE Gateway

PetOS BLE Gateway is a local Node.js bridge for controlling an ESP32-C3 PetOS watch over BLE.

It exposes three control surfaces over the same BLE connection:

- A browser dashboard for scanning, connecting, and sending pet commands.
- An HTTP API for scripts and local tools.
- A stdio MCP server for Codex, Claude, and other MCP clients.

```text
Web UI / HTTP API / MCP tool
        |
        v
Node.js gateway
        |
        v
BLE JSON write
        |
        v
PetOS-C3 watch
```

## Hardware/Firmware Assumptions

The current firmware advertises as `PetOS-C3` and accepts JSON writes on:

- Service UUID: `7f2a0001-4f6d-45f6-b805-2b0a7a0f9c01`
- Write characteristic UUID: `7f2a0002-4f6d-45f6-b805-2b0a7a0f9c01`

The tested target is an ESP32-C3 round watch board with a 240x240 GC9A01 display.

## Requirements

- macOS with Bluetooth enabled
- Node.js 20+
- A PetOS watch firmware advertising as `PetOS-C3`

This project uses `@abandonware/noble` for BLE access. On macOS, the terminal or app running Node may need Bluetooth permission in System Settings.

## Install

```bash
npm install
```

## Run The Web Gateway

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

The page lets you scan, connect, send named actions, send a fixed frame, or write raw JSON.

## CLI Smoke Tests

Scan:

```bash
npm run scan -- 7000
```

Send an action:

```bash
npm run send -- '{"cmd":"pet.action","value":"review"}'
```

Show a fixed frame:

```bash
npm run send -- '{"cmd":"pet.frame","value":12}'
```

## BLE JSON Protocol

Play an action:

```json
{"cmd":"pet.action","value":"idle"}
```

```json
{"cmd":"pet.action","value":"review"}
```

Show one fixed frame:

```json
{"cmd":"pet.frame","value":12}
```

Supported actions in the current firmware:

- `idle`
- `waving`
- `jumping`
- `failed`
- `waiting`
- `running`
- `review`

## HTTP API

Status:

```bash
curl http://127.0.0.1:8787/api/status
```

Scan:

```bash
curl -X POST http://127.0.0.1:8787/api/scan \
  -H 'content-type: application/json' \
  -d '{"timeoutMs":7000}'
```

Connect:

```bash
curl -X POST http://127.0.0.1:8787/api/connect \
  -H 'content-type: application/json' \
  -d '{}'
```

Play an action:

```bash
curl -X POST http://127.0.0.1:8787/api/action/review \
  -H 'content-type: application/json' \
  -d '{}'
```

Send raw JSON:

```bash
curl -X POST http://127.0.0.1:8787/api/send \
  -H 'content-type: application/json' \
  -d '{"cmd":"pet.frame","value":12}'
```

## MCP Server

Start the gateway first:

```bash
npm start
```

Then run the MCP server:

```bash
npm run mcp
```

For an MCP client, use this command:

```bash
node /absolute/path/to/petos-ble-gateway/src/mcp-server.js
```

Available MCP tools:

- `petos_status`
- `petos_scan`
- `petos_connect`
- `petos_send_json`
- `petos_play_action`
- `petos_show_frame`

The MCP server calls the local gateway at `http://127.0.0.1:8787` by default. Override with:

```bash
PETOS_GATEWAY_URL=http://127.0.0.1:8787 npm run mcp
```

## Troubleshooting

If the device does not appear in macOS Bluetooth settings, use this gateway or a BLE scanner such as nRF Connect/LightBlue. Ordinary BLE GATT devices often do not appear like keyboards or headphones.

If scanning hangs or returns no devices:

- Make sure the watch firmware is advertising `PetOS-C3`.
- Make sure the Node process has Bluetooth permission.
- Try `npm run scan -- 10000`.
- Restart the gateway after toggling Bluetooth permissions.

If action buttons appear to do nothing, check the log panel. A successful send looks like:

```text
sent {"cmd":"pet.action","value":"review"}
```
