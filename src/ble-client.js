import noble from "@abandonware/noble";
import { EventEmitter } from "node:events";
import { PETOS } from "./config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PetosBleClient extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.rx = null;
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
      });

      await target.connectAsync();
      const { characteristics } = await target.discoverSomeServicesAndCharacteristicsAsync(
        [PETOS.serviceUuid],
        [PETOS.rxUuid],
      );
      this.rx = characteristics.find((ch) => ch.uuid.toLowerCase() === PETOS.rxUuid);
      if (!this.rx) throw new Error("PetOS write characteristic not found");
      this.emit("log", `connected ${this.describe(target).name || target.id}`);
      return this.status();
    } finally {
      this.connecting = false;
    }
  }

  async disconnect() {
    if (this.peripheral?.state === "connected") await this.peripheral.disconnectAsync();
    this.rx = null;
    return this.status();
  }

  async sendJson(payload) {
    if (!this.rx || this.peripheral?.state !== "connected") await this.connect();
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    await this.rx.writeAsync(Buffer.from(body, "utf8"), false);
    this.emit("log", `sent ${body}`);
    return { ok: true, sent: body, status: this.status() };
  }
}
