export const PET_ACTIONS = ["idle", "waving", "jumping", "failed", "waiting", "running", "review"];

export const DEVICE_PROFILES = {
  "esp32-c3-round-240": {
    id: "esp32-c3-round-240",
    label: "ESP32-C3 Round Watch",
    names: ["PetOS-C3", "ESP32-2424S012"],
    display: { width: 240, height: 240, round: true },
    pet: { defaultSize: 200, maxSize: 200, defaultColors: 24, maxColors: 24, maxBytes: 1_400_000 },
    actions: PET_ACTIONS,
    capabilities: {
      bleJson: true,
      rleUpload: true,
      watchText: true,
      touch: true,
      brightness: false,
      petScale: false,
      audio: false,
      sounds: false,
      volume: false,
      mic: false,
      imu: false,
      autoRotate: false,
    },
    sounds: [],
  },
  "esp32-s3-smartring-360": {
    id: "esp32-s3-smartring-360",
    label: "ESP32-S3 SmartRing Plus",
    names: ["PetOS-S3", "TAIJI", "H03F1.4.0", "SmartRing"],
    display: { width: 360, height: 360, round: true },
    pet: { defaultSize: 360, maxSize: 360, defaultColors: 48, maxColors: 64, maxBytes: 2_000_000 },
    actions: PET_ACTIONS,
    capabilities: {
      bleJson: true,
      rleUpload: true,
      watchText: true,
      touch: true,
      brightness: true,
      petScale: true,
      audio: true,
      sounds: true,
      volume: true,
      mic: true,
      imu: true,
      autoRotate: true,
    },
    sounds: [
      { name: "woyaoyanpai", label: "Yanpai" },
      { name: "paimeiyouwenti", label: "No Problem" },
      { name: "geiwocapixie", label: "Capi Xie" },
      { name: "meizuo", label: "Meizuo" },
    ],
  },
};

export const GENERIC_PROFILE = {
  id: "generic-petos",
  label: "Generic PetOS BLE Device",
  names: [],
  display: { width: 240, height: 240, round: true },
  pet: { defaultSize: 200, maxSize: 200, defaultColors: 24, maxColors: 24, maxBytes: 1_000_000 },
  actions: PET_ACTIONS,
  capabilities: {
    bleJson: true,
    rleUpload: true,
    watchText: true,
    touch: false,
    brightness: false,
    petScale: false,
    audio: false,
    sounds: false,
    volume: false,
    mic: false,
    imu: false,
    autoRotate: false,
  },
  sounds: [],
};

function normalizeUuid(value) {
  return String(value || "").replace(/-/g, "").toLowerCase();
}

export function inferDeviceProfile(device, { serviceUuid } = {}) {
  const name = device?.name || "";
  for (const profile of Object.values(DEVICE_PROFILES)) {
    if (profile.names.some((needle) => name.includes(needle))) return profile;
  }
  const services = (device?.serviceUuids || []).map(normalizeUuid);
  if (serviceUuid && services.includes(normalizeUuid(serviceUuid))) return GENERIC_PROFILE;
  return GENERIC_PROFILE;
}

export function capabilitySnapshot(device, { serviceUuid } = {}) {
  const profile = inferDeviceProfile(device, { serviceUuid });
  return {
    profileId: profile.id,
    label: profile.label,
    display: profile.display,
    pet: profile.pet,
    actions: profile.actions,
    capabilities: profile.capabilities,
    sounds: profile.sounds,
  };
}

export function assertCapability(profile, key) {
  if (!profile.capabilities?.[key]) {
    throw new Error(`${profile.label} does not support ${key}`);
  }
}

export function validatePetPackageForProfile(meta, profile) {
  const issues = [];
  if (!meta) issues.push("missing idxrle metadata");
  else {
    if (meta.width > profile.pet.maxSize || meta.height > profile.pet.maxSize) {
      issues.push(`${meta.width}x${meta.height} exceeds ${profile.pet.maxSize}x${profile.pet.maxSize}`);
    }
    if (meta.colorCount > profile.pet.maxColors) {
      issues.push(`${meta.colorCount} colors exceeds ${profile.pet.maxColors}`);
    }
    if (meta.bytes > profile.pet.maxBytes) {
      issues.push(`${meta.bytes} bytes exceeds ${profile.pet.maxBytes}`);
    }
  }
  return {
    ok: issues.length === 0,
    issues,
  };
}
