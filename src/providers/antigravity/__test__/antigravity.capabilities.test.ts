import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityProvider } from "../index.ts";

test("AGH-48: capabilities are exactly the fifteen measured values", () => {
  assert.deepStrictEqual(antigravityProvider.capabilities(), {
    enforcesHooks: true,
    askSupportedOn: [],
    sessionEnv: false,
    nativeLoopCounter: false,
    dedicatedShellEvent: false,
    toolInputRewrite: false,
    toolOutputRewriteOn: [],
    contextAtToolBefore: false,
    contextAtToolAfter: false,
    contextAtStop: false,
    sessionStartContextReliable: false,
    toolOutputAtAfter: false,
    usageInPayload: false,
    effortSignal: false,
    thoughtEvent: false,
  });
});

test("AGH-49: policy defaults are empty and there is no lessons view", () => {
  assert.deepStrictEqual(antigravityProvider.policyDefaults(), {
    blockedPatterns: [],
    minEffort: null,
    untrustedTools: [],
  });
  assert.equal(antigravityProvider.lessonsView("/tmp"), null);
});
