import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withEnv } from "../../../../tools/test-env.scope.mjs";
import type { FloorHostFacts } from "../../../contracts/floor-host-facts.ts";
import { evaluateFloor, type FloorInput, type FloorRule } from "../floor.service.ts";

const PROJECT = "/home/dev/project";
const HOME = "/home/someone";
const EXTERNAL = "/outside/x";

/** A host with one wiring file in the project and one under the home, named neutrally. */
const PROJECT_TARGET = join(PROJECT, ".host", "wire.cfg");
const HOME_TARGET = join(HOME, ".tool", "conf", "wire.cfg");
const PROTECTED = [PROJECT_TARGET, HOME_TARGET];

function facts(overrides: Partial<FloorHostFacts> = {}): FloorHostFacts {
  return {
    wiringTextNames: [".host/wire.cfg", ".tool/conf/wire.cfg"],
    wiringFileNames: ["wire.cfg"],
    protectedAncestors: [join(PROJECT, ".host"), join(HOME, ".tool", "conf"), join(HOME, ".tool")],
    foldCase: true,
    ...overrides,
  };
}

function floor(input: Partial<FloorInput>) {
  return withEnv({ HOME, USERPROFILE: HOME }, () =>
    evaluateFloor({ projectDir: PROJECT, protectedPaths: PROTECTED, ...input }),
  );
}

function ruleOf(decision: { kind: string; reason?: string }): string | null {
  if (decision.kind !== "deny" || !decision.reason) {
    return null;
  }
  return /rule=([a-z-]+)/.exec(decision.reason)?.[1] ?? null;
}

function assertDenied(command: string, host: FloorHostFacts | undefined, rule: FloorRule): void {
  const decision = floor({ command, host });
  assert.equal(decision.kind, "deny", `expected deny for: ${command}`);
  assert.equal(ruleOf(decision), rule, `wrong rule for: ${command}`);
}

function assertAllowed(command: string, host: FloorHostFacts | undefined): void {
  const decision = floor({ command, host });
  assert.equal(decision.kind, "allow", `expected allow for: ${command} — got ${JSON.stringify(decision)}`);
}

test("AGF-17: an untranslated tool whose string argument names a wiring target is wiring tamper", () => {
  for (const strings of [
    ["C:\\w\\.HOST\\wire.cfg"],
    ["~/.tool/conf/wire.cfg"],
    ["a.txt", "%HOMEDIR%\\.tool\\conf\\wire.cfg"],
    ["the file .host/wire.cfg holds it"],
  ]) {
    const decision = floor({ host: facts({ untranslatedToolStrings: strings }) });
    assert.equal(ruleOf(decision), "wiring-tamper", strings.join(" | "));
  }
});

test("AGF-18: an untranslated tool that names no wiring target keeps the c31f3d4 decision", () => {
  assert.equal(floor({ host: facts({ untranslatedToolStrings: ["probe", "a subagent"] }) }).kind, "allow");
  assert.equal(floor({ host: facts() }).kind, "allow");
});

test("AGF-22: relative operands resolve against the host's base in every rule", () => {
  assertDenied("Get-Content id_rsa", facts({ shellBase: join(HOME, ".ssh") }), "secret-access");
  assertDenied(
    "Remove-Item -Recurse -Force .\\x",
    facts({ shellBase: EXTERNAL }),
    "outside-project-destruction",
  );
  assertAllowed("rm -Force ./wire.cfg", facts({ shellBase: join(PROJECT, "docs") }));
  assertAllowed("rm -rf ../../x", facts({ shellBase: join(PROJECT, "a", "b") }));
  const inHost = facts({ shellBase: join(PROJECT, ".host") });
  for (const command of [
    "rm -Force ./wire.cfg",
    "del wire.cfg",
    "echo {} > wire.cfg",
    "Set-Content wire.cfg '{}'",
  ]) {
    assertDenied(command, inHost, "wiring-tamper");
  }
  assertDenied(
    "Remove-Item -Force ./wire.cfg",
    facts({ shellBase: join(HOME, ".tool", "conf") }),
    "wiring-tamper",
  );
});

test("AGF-22a: an unresolvable base decides by the file name, then relative destruction, then relative moves", () => {
  const unresolvable = facts({ shellBaseUnresolvable: true });
  for (const command of [
    "Remove-Item -Force .\\wire.cfg",
    "echo {} > wire.cfg",
    "Set-Content WIRE.CFG '{}'",
  ]) {
    assertDenied(command, unresolvable, "wiring-tamper");
  }
  assertDenied("Remove-Item -Recurse .\\x", unresolvable, "unprovable-destruction");
  for (const command of [
    "Move-Item conf conf-old",
    "ren conf x",
    "mv conf x",
    "Move-Item .host x",
    "Rename-Item .host x",
  ]) {
    assertDenied(command, unresolvable, "wiring-tamper");
  }
  assertDenied(`Remove-Item -Recurse -Force ${EXTERNAL}`, unresolvable, "outside-project-destruction");
  for (const command of ["Get-Content id_rsa", "Copy-Item x.json conf", "cat .env"]) {
    assertAllowed(command, unresolvable);
  }
});

test("AGF-22b: destroying or moving a protected ancestor is wiring tamper, only with host facts", () => {
  for (const command of [
    "Remove-Item -Recurse -Force .host",
    "rd /s /q .host",
    "rm -rf .host",
    "Move-Item .host old-host",
    "mv .host x",
    "Rename-Item .host x",
    "ren .host x",
    "Move-Item ~/.tool/conf ~/.tool/conf-old",
    "Remove-Item -Recurse -Force ~/.tool",
    "Move-Item .host/wire.cfg x",
  ]) {
    assertDenied(command, facts(), "wiring-tamper");
  }
  assertDenied(
    "Remove-Item -Recurse -Force .",
    facts({ shellBase: join(PROJECT, ".host") }),
    "wiring-tamper",
  );
  assertAllowed("Remove-Item -Recurse -Force .host/skills", facts());
  assertAllowed("Remove-Item -Recurse -Force .host", undefined);
  assertAllowed("mv .host x", undefined);
});

test("AGF-22c: with facts, protected targets and ancestors compare without case", () => {
  assertDenied("rm -Force ./.HOST/Wire.Cfg", facts(), "wiring-tamper");
  assertDenied("del WIRE.cfg", facts({ shellBase: join(HOME, ".TOOL", "Conf") }), "wiring-tamper");
  assertDenied("Remove-Item -Recurse -Force .Host", facts(), "wiring-tamper");
  const write = floor({ toolName: "Write", filePath: join(PROJECT, ".HOST", "WIRE.CFG"), host: facts() });
  assert.equal(ruleOf(write), "wiring-tamper");
});

test("AGF-22d: the host's canonical form is applied to both sides of the comparison, and its failure propagates", () => {
  const alias = resolve("/alias");
  const canonical = (path: string) =>
    path.startsWith(alias) ? resolve(PROJECT, ".host") + path.slice(alias.length) : path;
  const aliased = facts({ canonical });
  assertDenied("Set-Content /alias/wire.cfg '{}'", aliased, "wiring-tamper");
  assertDenied("Remove-Item -Recurse -Force /alias", aliased, "wiring-tamper");
  assertDenied("Set-Content wire.cfg '{}'", facts({ canonical, shellBase: alias }), "wiring-tamper");
  assertAllowed("Get-ChildItem", facts({ canonical, shellBase: alias }));
  const throwing = facts({
    canonical: () => {
      throw new Error("no resolvable ancestor");
    },
  });
  assert.throws(() => floor({ command: "Remove-Item -Force ./x", host: throwing }), /no resolvable ancestor/);
});
