import { PetosBleClient } from "./ble-client.js";

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
  } else {
    console.error("Usage: node src/cli.js scan|connect|send '{\"cmd\":\"pet.action\",\"value\":\"review\"}'");
    process.exit(2);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
} finally {
  await ble.disconnect().catch(() => {});
  process.exit(0);
}
