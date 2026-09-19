import type { Policy } from "./policy.types.ts";

/**
 * why: "which rails are on" is a question three surfaces ask — the session report, to name the ones that never
 * fired; the attestation, to say what the session ran under; and doctor, eventually. Deriving it in each place is
 * how they come to disagree, so it is derived once here.
 *
 * invariant: a name in this list is the same string a decision carries as its `rule`. That equality is what lets a
 * report subtract "fired" from "active" and get a meaningful answer; if the two vocabularies drifted, every rail
 * would look silent.
 */
export function activeRails(policy: Policy): string[] {
  const rails: string[] = [];
  if (policy.shell.catastrophicAsk) {
    rails.push("shell-catastrophic");
  }
  if (policy.mode === "paired") {
    rails.push("shell-posture-paired");
  }
  if (policy.shell.stallDetection) {
    rails.push("shell-stall");
  }
  if (policy.comments.enabled) {
    rails.push("comments");
  }
  if (policy.planGate.enabled) {
    rails.push("plan-gate");
  }
  if (policy.shipGate.enabled) {
    rails.push("ship-gate");
  }
  if (policy.grind.enabled) {
    rails.push("grind");
  }
  if (policy.untrustedContent.enabled) {
    rails.push("untrusted-content");
  }
  // why: a row of its own, because the judge is a second rail behind one switch, with its own rule string and its
  // own cost. An operator who enabled it and was never asked anything needs it named and silent rather than folded
  // into the verbatim rail's count ([/decisions/ad-146.md](/decisions/ad-146.md)).
  if (policy.untrustedContent.judge.enabled) {
    rails.push("untrusted-judge");
  }
  if (policy.intelligence.idleTurnGate) {
    rails.push("idle-turn");
  }
  if (policy.subagents.enforceAllowlist) {
    rails.push("subagent-allowlist");
  }
  return rails;
}
