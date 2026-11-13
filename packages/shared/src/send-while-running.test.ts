import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEND_WHILE_RUNNING_MODE,
  resolveSendWhileRunningMode,
} from "./send-while-running.js";

describe("resolveSendWhileRunningMode", () => {
  it("keeps steering for a settings document that predates the field", () => {
    expect(DEFAULT_SEND_WHILE_RUNNING_MODE).toBe("immediate");
    expect(resolveSendWhileRunningMode(undefined)).toBe("immediate");
    expect(resolveSendWhileRunningMode(null)).toBe("immediate");
  });

  it("accepts the queue opt-in and ignores unusable values", () => {
    expect(resolveSendWhileRunningMode("queue")).toBe("queue");
    expect(resolveSendWhileRunningMode("immediate")).toBe("immediate");
    expect(resolveSendWhileRunningMode("steer")).toBe("immediate");
    expect(resolveSendWhileRunningMode(1)).toBe("immediate");
  });
});
