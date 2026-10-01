import type { ProviderPort } from "../provider.port.ts";
import { codexCapabilities } from "./codex.capabilities.ts";
import { detectCodex } from "./codex.detect.ts";
import { codexFailClosed } from "./codex.failure.ts";
import { codexToEvent } from "./codex.inbound.ts";
import { codexRender } from "./codex.outbound.ts";
import { codexPolicyDefaults } from "./codex.policy-defaults.ts";
import { codexWiring, codexWiringTargets } from "./codex.wiring.ts";

export const codexProvider: ProviderPort = {
  name: "codex",
  detect: detectCodex,
  capabilities: codexCapabilities,
  policyDefaults: codexPolicyDefaults,
  toEvent: codexToEvent,
  render: codexRender,
  wiring: codexWiring,
  wiringTargets: codexWiringTargets,
  failClosed: codexFailClosed,
  // why: this host has no view its model would read.
  lessonsView: (_root: string): string | null => null,
};
