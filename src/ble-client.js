import noble from "@abandonware/noble";
import { EventEmitter } from "node:events";
import { PETOS } from "./config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RLE_CHUNK_MAGIC = Buffer.from("RLEC");

export class PetosBleClient extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.rx = null;
    this.tx = null;
    this.lastScan = [];
    this.connecting = false;
  }

  status() {
    return {
      adapterState: noble.state,
      connected: Boolean(this.peripheral && this.peripheral.state === "connected" && this.rx),
      device: this.peripheral ? this.describe(this.peripheral) : null,
      serviceUuid: PETOS.serviceUuid,
      rxUuid: PETOS.rxUuid,
      txUuid: PETOS.txUuid,
      lastScan: this.lastScan,
    };
  }

  describe(peripheral) {
    return {
      id: peripheral.id,
      uuid: peripheral.uuid,
      address: peripheral.address,
      addressType: peripheral.addressType,
      name: peripheral.advertisement?.localName || "",
      rssi: peripheral.rssi,
      state: peripheral.state,
      serviceUuids: peripheral.advertisement?.serviceUuids || [],
    };
  }

  async waitForPoweredOn(timeoutMs = 8000) {
    if (noble.state === "poweredOn") return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.off("stateChange", onState);
        reject(new Error(`Bluetooth adapter state is ${noble.state}; not poweredOn`));
      }, timeoutMs);
      const onState = (state) => {
        if (state === "poweredOn") {
          clearTimeout(timer);
          noble.off("stateChange", onState);
          resolve();
        }
      };
      noble.on("stateChange", onState);
    });
  }

  async scan({ timeoutMs = 7000, name = PETOS.deviceName } = {}) {
    await this.waitForPoweredOn();
    const found = new Map();

    const onDiscover = (peripheral) => {
      const info = this.describe(peripheral);
      const matchesName = !name || info.name === name || info.name.includes(name);
      const matchesService = info.serviceUuids.map((x) => x.toLowerCase()).includes(PETOS.serviceUuid);
      if (matchesName || matchesService) {
        found.set(peripheral.id, peripheral);
        this.emit("log", `found ${info.name || "(unnamed)"} ${info.id} rssi=${info.rssi}`);
      }
    };

    noble.on("discover", onDiscover);
    await noble.startScanningAsync([], false);
    await delay(timeoutMs);
    await noble.stopScanningAsync().catch(() => {});
    noble.off("discover", onDiscover);

    this.lastScan = [...found.values()].map((p) => this.describe(p)).sort((a, b) => b.rssi - a.rssi);
    return this.lastScan;
  }

  async connect({ timeoutMs = 9000 } = {}) {
    if (this.peripheral?.state === "connected" && this.rx) return this.status();
    if (this.connecting) throw new Error("connect already in progress");
    this.connecting = true;
    try {
      await this.waitForPoweredOn();
      let target = null;

      const candidates = await this.scan({ timeoutMs: Math.min(timeoutMs, 5000) });
      if (candidates.length) {
        const id = candidates[0].id;
        target = noble._peripherals?.[id];
      }
      if (!target) throw new Error(`Cannot find BLE device ${PETOS.deviceName}`);

      this.peripheral = target;
      this.peripheral.once("disconnect", () => {
        this.emit("log", "device disconnected");
        this.rx = null;
        this.tx = null;
      });

      await target.connectAsync();
      const { characteristics } = await target.discoverSomeServicesAndCharacteristicsAsync(
        [PETOS.serviceUuid],
        [PETOS.rxUuid, PETOS.txUuid],
      );
      this.rx = characteristics.find((ch) => ch.uuid.toLowerCase() === PETOS.rxUuid);
      if (!this.rx) throw new Error("PetOS write characteristic not found");
      this.tx = characteristics.find((ch) => ch.uuid.toLowerCase() === PETOS.txUuid);
      if (this.tx) {
        this.tx.on("data", (data) => {
          const text = data.toString("utf8");
          this.emit("log", `watch ${text}`);
          try {
            this.emit("watchMessage", JSON.parse(text));
          } catch {
            this.emit("watchMessage", { event: "text", text });
          }
        });
        await this.tx.subscribeAsync();
      }
      this.emit("log", `connected ${this.describe(target).name || target.id}`);
      return this.status();
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    if (this.peripheral?.state === "connected") await this.peripheral.disconnectAsync();
    this.rx = null;
    this.tx = null;
    return this.status();
  }

  waitForWatchEvent(events, timeoutMs = 20000) {
    const wanted = new Set(Array.isArray(events) ? events : [events]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("watchMessage", onMessage);
        reject(new Error(`Timed out waiting for watch event: ${[...wanted].join(", ")}`));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!wanted.has(message.event)) return;
        clearTimeout(timer);
        this.off("watchMessage", onMessage);
        if (message.event === "rle.error") reject(new Error(`watch RLE error: ${JSON.stringify(message)}`));
        else resolve(message);
      };
      this.on("watchMessage", onMessage);
    });
  }

  async sendJson(payload) {
    if (!this.rx || this.peripheral?.state !== "connected") await this.connect();
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    await this.rx.writeAsync(Buffer.from(body, "utf8"), false);
    this.emit("log", `sent ${body}`);
    return { ok: true, sent: body, status: this.status() };
  }

  async uploadRle(input, { chunkSize = 160, delayMs = 10, onProgress } = {}) {
    if (!this.rx || this.peripheral?.state !== "connected") await this.connect();
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (data.length < 16 || data.subarray(0, 8).toString("ascii") !== "PTOSIDX1") {
      throw new Error("RLE upload expects a PTOSIDX1 .idxrle package");
    }
    if (chunkSize < 32 || chunkSize > 480) throw new Error("chunkSize must be between 32 and 480");

    const beginWait = this.tx ? this.waitForWatchEvent(["rle.begin", "rle.error"], 10000) : null;
    await this.sendJson({ cmd: "rle.begin", size: data.length });
    if (beginWait) await beginWait;
    let sent = 0;
    while (sent < data.length) {
      const payload = data.subarray(sent, Math.min(sent + chunkSize, data.length));
      const packet = Buffer.allocUnsafe(8 + payload.length);
      RLE_CHUNK_MAGIC.copy(packet, 0);
      packet.writeUInt32LE(sent, 4);
      payload.copy(packet, 8);
      await this.rx.writeAsync(packet, false);
      sent += payload.length;
      onProgress?.({ sent, total: data.length, percent: sent / data.length });
      if (delayMs > 0) await delay(delayMs);
    }
    const completeWait = this.tx ? this.waitForWatchEvent(["rle.complete", "rle.error"], 30000) : null;
    await this.sendJson({ cmd: "rle.end" });
    const watch = completeWait ? await completeWait : null;
    this.emit("log", `uploaded RLE ${data.length} bytes`);
    return { ok: true, bytes: data.length, watch, status: this.status() };
  }
}
