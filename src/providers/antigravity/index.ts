import type { ProviderPort } from "../provider.port.ts";
import { antigravityCapabilities } from "./antigravity.capabilities.ts";
import { detectAntigravity } from "./antigravity.detect.ts";
import { antigravityFailClosed } from "./antigravity.failure.ts";
import { antigravityFloorHostFacts } from "./antigravity.floor-facts.ts";
import { antigravityToEvent } from "./antigravity.inbound.ts";
import { antigravityRender } from "./antigravity.outbound.ts";
import { antigravityCanonicalWiringMatch } from "./antigravity.paths.ts";
import { antigravityPolicyDefaults } from "./antigravity.policy-defaults.ts";
import {
  antigravityProjectWiringTargets,
  antigravityWiring,
  antigravityWiringTargets,
} from "./antigravity.wiring.ts";

export const antigravityProvider: ProviderPort = {
  name: "antigravity",
  detect: detectAntigravity,
  capabilities: antigravityCapabilities,
  policyDefaults: antigravityPolicyDefaults,
  toEvent: antigravityToEvent,
  render: antigravityRender,
  wiring: antigravityWiring,
  wiringTargets: antigravityWiringTargets,
  projectWiringTargets: antigravityProjectWiringTargets,
  failClosed: antigravityFailClosed,
  canonicalWiringMatch: antigravityCanonicalWiringMatch,
  floorHostFacts: antigravityFloorHostFacts,
  // why: the host has no view to write lessons into that its model would read.
  lessonsView: (_root: string): string | null => null,
};
