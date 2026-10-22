import type { Reader } from "./upward-anchor-reader";
import type { Sampler } from "./upward-anchor-sampling";
import type { PageGate, ReadRecord } from "./upward-anchor-fixture";

/*
  Shared state of one probe run: the mounted host, the frame sampler, the
  reader actions, the recorded history reads, and the reports the phases fill
  in. The phases are plain functions over this context so the mutable state has
  exactly one owner.
*/
export type Probe = {
  host: HTMLDivElement;
  sampler: Sampler;
  reader: Reader;
  reads: ReadRecord[];
  reports: Record<string, Record<string, unknown>>;
  regroup: Record<string, unknown>;
  /** The exact-top conversation's withheld older-page answers. */
  gate: PageGate;
};
