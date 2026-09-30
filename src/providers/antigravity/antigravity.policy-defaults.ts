import type { ProviderPolicyDefaults } from "../../contracts/index.ts";

export function antigravityPolicyDefaults(): ProviderPolicyDefaults {
  return {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  };
}
