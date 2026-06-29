# PetOS BLE Gateway

PetOS BLE Gateway is a local Node.js bridge for controlling PetOS ESP32 round watch devices over BLE.

It exposes three control surfaces over the same device session:

- A browser dashboard for scanning, connecting, and sending pet commands.
- An HTTP API for scripts and local tools.
- A stdio MCP server for Codex, Claude, and other MCP clients.

```text
Web UI / HTTP API / MCP tool
        |
        v
Node.js gateway
        | BLE JSON + notify state
        v
PetOS watch
        |
        +-- optional WiFi RLE upload endpoint
```

The gateway keeps Node and watch state synchronized from BLE notifications:
connection profile, WiFi IP/ports, active upload progress, active pet slot,
current tab, and audio state.

## Hardware/Firmware Assumptions

The current firmware family accepts JSON writes on:

- Service UUID: `7f2a0001-4f6d-45f6-b805-2b0a7a0f9c01`
- Write characteristic UUID: `7f2a0002-4f6d-45f6-b805-2b0a7a0f9c01`
- Notify characteristic UUID: `7f2a0003-4f6d-45f6-b805-2b0a7a0f9c01`

The gateway detects the connected device profile from BLE advertising:

- `PetOS-C3`: 240x240 C3 round watch, 200px / 24-color pet package target, no audio/IMU controls.
- `PetOS-S3`: 360x360 SmartRing Plus, 360px / 48-color pet package target, audio, volume, brightness, IMU/auto-rotate, and pet scale controls.

Device capabilities are returned by `/api/status` and `/api/capabilities`. The Web UI, HTTP API, and MCP tools use those capabilities to disable or reject unsupported actions.

## Requirements

- macOS with Bluetooth enabled
- Node.js 20+
- A PetOS watch firmware advertising as `PetOS-C3` or `PetOS-S3`

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

The page lets you scan, connect, see the detected device profile, send named actions, show a fixed frame, switch pet slots, switch watch tabs, show or clear a pet speech bubble, update the watch text page, or write raw JSON.
It can also pack Codex pets into `.idxrle` packages, list saved packages with a preview frame, and upload a saved package to the watch over BLE or WiFi.
If a package does not fit the connected device profile, its upload button is disabled with the reason shown in the card.

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

Upload a pet RLE package:

```bash
npm run upload -- /absolute/path/to/pet.idxrle
```

Pack a Codex pet into a watch-ready RLE package:

```bash
npm run pack -- cloud-strife
```

Pack and upload in one command:

```bash
npm run pack-upload -- cloud-strife
```

The packer uses the standard Codex pet `8x9` sprite sheet layout, removes empty cells, and excludes `run_right` / `run_left` for the watch package.
When connected, pack defaults follow the device profile: C3 defaults to `200x200` / `24` colors, S3 defaults to `360x360` / `48` colors.
Packed packages are saved under `packed/<pet>/`. Running the same pet/settings again reuses the matching `.idxrle`; add `--force` to rebuild:

```bash
npm run pack -- cloud-strife --force
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

Show or clear a pet speech bubble:

```json
{"cmd":"pet.say","text":"Codex 收到了，开始思考"}
```

```json
{"cmd":"pet.bubble.clear"}
```

Switch pet slot or UI tab:

```json
{"cmd":"pet.slot","value":1}
```

```json
{"cmd":"ui.tab","value":"settings","animate":1}
```

Show multiline text on the second watch page:

```json
{"cmd":"watch.text","title":"Market","text":"#22c55e CPO +2.3%#\n#f97316 NVDA +1.1%#"}
```

The watch firmware supports LVGL label recolor syntax for simple rich text:

```text
#22c55e green text# #f97316 orange text#
```

This is not HTML or Markdown. It supports multiline text and color spans, but not mixed font sizes, bold text, or embedded images.

Supported actions in the current firmware:

- `idle`
- `waving`
- `jumping`
- `failed`
- `waiting`
- `running`
- `review`

Upload a new pet package:

```json
{"cmd":"rle.begin","size":561600}
```

Then send binary BLE chunks:

```text
"RLEC" + uint32_le(offset) + raw bytes
```

Finish:

```json
{"cmd":"rle.end"}
```

The firmware writes to the selected pet slot (`/pets/pet0.idxrle`, `/pets/pet1.idxrle`, or `/pets/pet2.idxrle`). During upload the watch hides pet frames and shows a progress bar plus an abort button. After `rle.end`, the gateway waits for the watch notification:

```json
{"event":"rle.complete","a":41,"b":778786}
```

The web/CLI upload should only be treated as successful after this watch-side acknowledgement. If the upload is interrupted, upload the `.idxrle` again.

For larger S3 packages, the gateway can configure WiFi over BLE, receive the watch IP/ports from BLE notifications, and upload the `.idxrle` over the watch TCP pull protocol. BLE upload remains available as a fallback.

## HTTP API

Status:

```bash
curl http://127.0.0.1:8787/api/status
```

Capabilities only:

```bash
curl http://127.0.0.1:8787/api/capabilities
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

Update the second watch page text:

```bash
curl -X POST http://127.0.0.1:8787/api/watch/text \
  -H 'content-type: application/json' \
  -d '{"title":"Market","text":"#22c55e CPO +2.3%#\n#f97316 NVDA +1.1%#"}'
```

Show or clear the pet speech bubble:

```bash
curl -X POST http://127.0.0.1:8787/api/pet/say \
  -H 'content-type: application/json' \
  -d '{"text":"Codex 收到了，开始思考"}'

curl -X POST http://127.0.0.1:8787/api/pet/bubble/clear \
  -H 'content-type: application/json' \
  -d '{}'
```

Switch pet slot or watch tab:

```bash
curl -X POST http://127.0.0.1:8787/api/pet/slot \
  -H 'content-type: application/json' \
  -d '{"value":1}'

curl -X POST http://127.0.0.1:8787/api/tab \
  -H 'content-type: application/json' \
  -d '{"value":"settings"}'
```

Configure or disconnect watch WiFi:

```bash
curl -X POST http://127.0.0.1:8787/api/wifi/config \
  -H 'content-type: application/json' \
  -d '{"ssid":"YOUR_SSID","password":"YOUR_PASSWORD"}'

curl -X POST http://127.0.0.1:8787/api/wifi/disconnect \
  -H 'content-type: application/json' \
  -d '{}'
```

Upload an `.idxrle` file:

```bash
curl -X POST 'http://127.0.0.1:8787/api/rle/upload?chunkSize=160&delayMs=10' \
  -H 'content-type: application/octet-stream' \
  --data-binary @/absolute/path/to/pet.idxrle
```

List saved packages:

```bash
curl http://127.0.0.1:8787/api/rle/packages
```

Upload a saved package from `packed/`:

```bash
curl -X POST http://127.0.0.1:8787/api/rle/upload-file \
  -H 'content-type: application/json' \
  -d '{"file":"cloud-strife/cloud-strife_watch-no-lr_200_24.idxrle","chunkSize":160,"delayMs":10}'
```

Use WiFi for the same saved package:

```bash
curl -X POST http://127.0.0.1:8787/api/rle/upload-file \
  -H 'content-type: application/json' \
  -d '{"file":"cloud-strife/cloud-strife_watch-no-lr_360_48.idxrle","transport":"wifi","slot":0}'
```

Pack a Codex pet:

```bash
curl -X POST http://127.0.0.1:8787/api/rle/pack \
  -H 'content-type: application/json' \
  -d '{"name":"cloud-strife","colors":24,"size":200}'
```

Pack and upload:

```bash
curl -X POST http://127.0.0.1:8787/api/rle/pack-upload \
  -H 'content-type: application/json' \
  -d '{"name":"cloud-strife","colors":24,"size":200,"chunkSize":160,"delayMs":10}'
```

S3-only audio and display controls:

```bash
curl -X POST http://127.0.0.1:8787/api/audio/play/meizuo \
  -H 'content-type: application/json' \
  -d '{}'

curl -X POST http://127.0.0.1:8787/api/audio/volume \
  -H 'content-type: application/json' \
  -d '{"value":80}'

curl -X POST http://127.0.0.1:8787/api/display/brightness \
  -H 'content-type: application/json' \
  -d '{"value":80}'

curl -X POST http://127.0.0.1:8787/api/display/autorotate \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'

curl -X POST http://127.0.0.1:8787/api/pet/scale \
  -H 'content-type: application/json' \
  -d '{"value":120}'
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
- `petos_select_pet`
- `petos_say`
- `petos_clear_bubble`
- `petos_open_tab`
- `petos_show_frame`
- `petos_show_text`
- `petos_upload_rle`
- `petos_pack_rle`
- `petos_pack_upload_pet`
- `petos_play_sound`
- `petos_set_volume`
- `petos_set_brightness`
- `petos_set_auto_rotate`
- `petos_set_pet_scale`

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
