export const PETOS = {
  deviceName: "PetOS",
  serviceUuid: "7f2a00014f6d45f6b8052b0a7a0f9c01",
  rxUuid: "7f2a00024f6d45f6b8052b0a7a0f9c01",
  txUuid: "7f2a00034f6d45f6b8052b0a7a0f9c01",
};

export const DEFAULT_PORT = Number(process.env.PETOS_GATEWAY_PORT || 8787);
export const DEFAULT_URL = process.env.PETOS_GATEWAY_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
