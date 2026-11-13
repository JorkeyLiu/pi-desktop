import type { SendWhileRunningMode } from "./types/settings.js";

/**
 * An ordinary composer send into a session that is still running steers the
 * message into the active turn by default. Settings documents written before
 * this preference existed carry no value, and they must keep that behavior:
 * queueing is the opt-in that waits for the turn to finish.
 */
export const DEFAULT_SEND_WHILE_RUNNING_MODE: SendWhileRunningMode = "immediate";

/** Resolve the persisted preference; anything unrecognized uses the default. */
export function resolveSendWhileRunningMode(value: unknown): SendWhileRunningMode {
  return value === "queue" ? "queue" : DEFAULT_SEND_WHILE_RUNNING_MODE;
}
