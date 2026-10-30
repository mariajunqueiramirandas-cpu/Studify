// On Android every token fetch also emits the "token changed" event (expo-notifications PushTokenModule.kt calls
// onNewToken after each fetch). Registration must not answer its own event, or it saves the token in a loop.
const mockListeners: Array<(token: { type: string; data: string }) => void> =
  [];
let mockDeviceToken = "fcm-1";

jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: { version: "0.2.0", extra: { eas: { projectId: "p1" } } },
  },
}));
jest.mock("expo-notifications", () => {
  const getDevicePushTokenAsync = async () => {
    const token = { type: "android", data: mockDeviceToken };
    // What the native module does after every fetch.
    setTimeout(() => mockListeners.forEach((l) => l(token)), 0);
    return token;
  };
  return {
    getPermissionsAsync: async () => ({ granted: true }),
    getDevicePushTokenAsync,
    // Like the library: without a device token it fetches one itself.
    getExpoPushTokenAsync: async (opts: {
      devicePushToken?: { data: string };
    }) => {
      const device = opts.devicePushToken ?? (await getDevicePushTokenAsync());
      return { data: `ExponentPushToken[${device.data}]` };
    },
    addPushTokenListener: (
      l: (token: { type: string; data: string }) => void,
    ) => {
      mockListeners.push(l);
      return {
        remove: () => mockListeners.splice(mockListeners.indexOf(l), 1),
      };
    },
  };
});
jest.mock("../../../lib/device", () => ({ getDeviceId: () => "device-1" }));
jest.mock("../../../lib/logger", () => ({ logger: { warn: jest.fn() } }));
const mockSaved: string[] = [];
jest.mock("../../../api/data", () => ({
  data: jest.fn(async (_name: string, input: { token: string }) => {
    mockSaved.push(input.token);
    return { outcome: "registered" };
  }),
}));

import { registerPushToken, watchPushToken } from "../push-token";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("push token registration", () => {
  it("saves once, not again for the event its own fetch emitted, and again when FCM really rotates the token", async () => {
    const stop = watchPushToken("u1");
    await registerPushToken("u1");
    await settle();
    await settle();
    expect(mockSaved).toEqual(["ExponentPushToken[fcm-1]"]);

    mockDeviceToken = "fcm-2";
    mockListeners.forEach((l) => l({ type: "android", data: "fcm-2" }));
    await settle();
    await settle();
    expect(mockSaved).toEqual([
      "ExponentPushToken[fcm-1]",
      "ExponentPushToken[fcm-2]",
    ]);
    stop();
  });

  it("runs one registration at a time", async () => {
    mockSaved.length = 0;
    await Promise.all([
      registerPushToken("u1"),
      registerPushToken("u1"),
      registerPushToken("u1"),
    ]);
    expect(mockSaved).toHaveLength(1);
  });
});
