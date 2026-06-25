import { PetosBleClient } from "./ble-client.js";
import { packCodexPet } from "./rle-pack.js";
import fs from "node:fs/promises";

const ble = new PetosBleClient();
ble.on("log", (line) => console.error(`[petos] ${line}`));

const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === "scan") {
    console.log(JSON.stringify(await ble.scan({ timeoutMs: Number(args[0] || 7000) }), null, 2));
  } else if (cmd === "connect") {
    console.log(JSON.stringify(await ble.connect(), null, 2));
  } else if (cmd === "send") {
    const payload = args.join(" ") || '{"cmd":"pet.action","value":"idle"}';
    console.log(JSON.stringify(await ble.sendJson(JSON.parse(payload)), null, 2));
  } else if (cmd === "upload") {
    const file = args[0];
    if (!file) throw new Error("Usage: node src/cli.js upload path/to/pet.idxrle");
    const data = await fs.readFile(file);
    let lastPct = -1;
    const result = await ble.uploadRle(data, {
      onProgress: ({ sent, total, percent }) => {
        const pct = Math.floor(percent * 100);
        if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          console.error(`[petos] upload ${pct}% ${sent}/${total}`);
        }
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "pack") {
    const name = args[0];
    if (!name) throw new Error("Usage: node src/cli.js pack cloud-strife [colors]");
    const result = await packCodexPet({ name, colors: Number(args[1] || 24) });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "pack-upload") {
    const name = args[0];
    if (!name) throw new Error("Usage: node src/cli.js pack-upload cloud-strife [colors]");
    const packed = await packCodexPet({ name, colors: Number(args[1] || 24) });
    console.error(`[petos] packed ${packed.file} ${packed.bytes} bytes`);
    const data = await fs.readFile(packed.file);
    let lastPct = -1;
    const upload = await ble.uploadRle(data, {
      onProgress: ({ sent, total, percent }) => {
        const pct = Math.floor(percent * 100);
        if (pct >= lastPct + 5 || sent === total) {
          lastPct = pct;
          console.error(`[petos] upload ${pct}% ${sent}/${total}`);
        }
      },
    });
    console.log(JSON.stringify({ ok: true, packed, upload }, null, 2));
  } else {
    console.error("Usage: node src/cli.js scan|connect|send '{\"cmd\":\"pet.action\",\"value\":\"review\"}'|upload pet.idxrle|pack cloud-strife|pack-upload cloud-strife");
    process.exit(2);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
} finally {
  await ble.disconnect().catch(() => {});
  process.exit(0);
}
