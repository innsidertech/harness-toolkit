import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "../../../contracts/index.ts";
import { antigravityCanonicalPath, antigravityCanonicalWiringMatch } from "../antigravity.paths.ts";

const PROJECT = "C:\\w";
const HOME = "C:\\Users\\dev";
const TARGET = "C:\\Users\\dev\\.gemini\\config\\hooks.json";

/** A disk where every path exists and resolves to itself. */
const plainDisk = {
  platform: "win32" as const,
  exists: () => true,
  realpath: (path: string) => path,
  home: HOME,
};

/** A disk that holds only the listed paths, with the listed realpaths. */
function disk(existing: readonly string[], realpaths: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      platform: "win32" as const,
      exists: (path: string) => existing.includes(path),
      realpath: (path: string) => {
        calls.push(path);
        return realpaths[path] ?? path;
      },
      home: HOME,
    },
  };
}

test("path alias: the \\\\?\\ and \\\\.\\ prefixes are removed", () => {
  assert.equal(antigravityCanonicalPath(`\\\\?\\${TARGET}`, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`\\\\.\\${TARGET}`, PROJECT, plainDisk), TARGET);
});

test("path alias: a stream suffix from :: to the end of the last segment is removed, ::$DATA included", () => {
  assert.equal(antigravityCanonicalPath(`${TARGET}::$DATA`, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`${TARGET}::`, PROJECT, plainDisk), TARGET);
});

test("path alias: the whole trailing run of dots and spaces leaves the last segment", () => {
  assert.equal(antigravityCanonicalPath(`${TARGET}.`, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`${TARGET} `, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`${TARGET}. .`, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`${TARGET}..`, PROJECT, plainDisk), TARGET);
});

test("path alias: a . or .. last segment is left as it is", () => {
  assert.equal(antigravityCanonicalPath("C:\\w\\x\\..", PROJECT, plainDisk), "C:\\w");
  assert.equal(antigravityCanonicalPath("C:\\w\\x\\.", PROJECT, plainDisk), "C:\\w\\x");
});

test("path alias: the four steps run in order, so a stream suffix after a dot still loses both", () => {
  assert.equal(antigravityCanonicalPath(`\\\\?\\${TARGET}. ::$DATA`, PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath(`\\\\.\\${TARGET}.::$DATA`, PROJECT, plainDisk), TARGET);
});

test("path alias: realpath runs on the longest existing ancestor and the missing segments join unchanged", () => {
  const { calls, deps } = disk(["C:\\", "C:\\j"], { "C:\\j": "D:\\Real" });
  assert.equal(
    antigravityCanonicalPath("C:\\j\\Missing\\Case.JSON", PROJECT, deps),
    "D:\\Real\\Missing\\Case.JSON",
  );
  assert.deepEqual(calls, ["C:\\j"]);
});

test("path alias: a path that exists is itself the ancestor realpath runs on", () => {
  const { calls, deps } = disk(["C:\\", "C:\\PROGRA~1", "C:\\PROGRA~1\\x.json"], {
    "C:\\PROGRA~1\\x.json": "C:\\Program Files\\x.json",
  });
  assert.equal(antigravityCanonicalPath("C:\\PROGRA~1\\x.json", PROJECT, deps), "C:\\Program Files\\x.json");
  assert.deepEqual(calls, ["C:\\PROGRA~1\\x.json"]);
});

test("path alias: with no existing ancestor there is nothing to resolve, and the absolute path is the form", () => {
  const { calls, deps } = disk([]);
  assert.equal(antigravityCanonicalPath("Z:\\nowhere\\hooks.json", PROJECT, deps), "Z:\\nowhere\\hooks.json");
  assert.deepEqual(calls, []);
});

const VOLUME = "\\\\?\\Volume{1903db38-a741-4d61-bcc9-107896be8d3d}";

test("path alias: a device prefix before a name that is not a drive letter stays and reaches realpath", () => {
  for (const root of [
    VOLUME,
    "\\\\.\\Volume{1903db38-a741-4d61-bcc9-107896be8d3d}",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume7",
  ]) {
    const users = `${root}\\Users`;
    const { calls, deps } = disk([users], { [users]: "C:\\Users" });
    assert.equal(
      antigravityCanonicalPath(`${users}\\dev\\.gemini\\config\\hooks.json`, PROJECT, deps),
      TARGET,
      root,
    );
    assert.deepEqual(calls, [users], root);
  }
});

test("path alias: under a kept device prefix with no existing ancestor, the form throws", () => {
  const { calls, deps } = disk([]);
  for (const path of [
    "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x\\hooks.json",
    "\\\\?\\GLOBALROOT\\Device\\Nope\\x\\hooks.json",
    "\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\x",
  ]) {
    assert.throws(
      () => antigravityCanonicalPath(path, PROJECT, deps),
      /canonical path: no resolvable ancestor/,
      path,
    );
  }
  assert.deepEqual(calls, []);
});

test("path alias: the no-resolvable-ancestor error does not carry the path", () => {
  const { deps } = disk([]);
  assert.throws(
    () => antigravityCanonicalPath(`${VOLUME}\\secret-name\\hooks.json`, PROJECT, deps),
    (error: Error) => !error.message.includes("secret-name"),
  );
});

test("path alias: a realpath that answers with a drive-letter device prefix loses it again", () => {
  for (const prefix of ["\\\\?\\", "\\\\.\\"]) {
    const users = `${VOLUME}\\Users`;
    const { deps } = disk([users], { [users]: `${prefix}C:\\Users` });
    assert.equal(
      antigravityCanonicalPath(`${users}\\dev\\.gemini\\config\\hooks.json`, PROJECT, deps),
      TARGET,
      prefix,
    );
  }
});

test("path alias: trailing dots and spaces leave a middle segment that does not exist yet, and . and .. stay", () => {
  const { deps } = disk(["C:\\", "C:\\w"]);
  assert.equal(
    antigravityCanonicalPath("C:\\w\\.agents.\\hooks.json", PROJECT, deps),
    "C:\\w\\.agents\\hooks.json",
  );
  assert.equal(
    antigravityCanonicalPath("C:\\w\\.agents \\hooks.json", PROJECT, deps),
    "C:\\w\\.agents\\hooks.json",
  );
  assert.equal(
    antigravityCanonicalPath("C:\\w\\.agents. .\\hooks.json", PROJECT, deps),
    "C:\\w\\.agents\\hooks.json",
  );
  assert.equal(antigravityCanonicalPath(".agents.\\hooks.json", PROJECT, deps), "C:\\w\\.agents\\hooks.json");
  assert.equal(
    antigravityCanonicalPath("C:\\w\\x\\..\\.agents\\hooks.json", PROJECT, deps),
    "C:\\w\\.agents\\hooks.json",
  );
  assert.equal(
    antigravityCanonicalPath("C:\\w\\.\\.agents\\hooks.json", PROJECT, deps),
    "C:\\w\\.agents\\hooks.json",
  );
});

test("path alias: a kept device prefix is not touched by the trailing-dot step", () => {
  const users = "\\\\.\\Volume{1903db38-a741-4d61-bcc9-107896be8d3d}\\Users";
  const { calls, deps } = disk([users], { [users]: "C:\\Users" });
  assert.equal(antigravityCanonicalPath(`${users}.\\dev \\x.json`, PROJECT, deps), "C:\\Users\\dev\\x.json");
  assert.deepEqual(calls, [users]);
});

test("path alias: ~ expands with the home, and a relative path resolves under the project", () => {
  assert.equal(antigravityCanonicalPath("~\\.gemini\\config\\hooks.json", PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath("~/.gemini/config/hooks.json", PROJECT, plainDisk), TARGET);
  assert.equal(antigravityCanonicalPath("~", PROJECT, plainDisk), HOME);
  assert.equal(
    antigravityCanonicalPath(".agents\\hooks.json", PROJECT, plainDisk),
    "C:\\w\\.agents\\hooks.json",
  );
});

test("path alias: off Windows the form is the path itself, untouched and unresolved", () => {
  const { calls, deps } = disk([]);
  const odd = `\\\\?\\${TARGET}. ::$DATA`;
  assert.equal(antigravityCanonicalPath(odd, PROJECT, { ...deps, platform: "linux" }), odd);
  assert.equal(antigravityCanonicalPath("~/x", PROJECT, { ...deps, platform: "darwin" }), "~/x");
  assert.deepEqual(calls, []);
});

test("path alias: a realpath failure is thrown, not swallowed", () => {
  const failing = {
    ...plainDisk,
    realpath: () => {
      throw new Error("EACCES: realpath refused");
    },
  };
  assert.throws(() => antigravityCanonicalPath(TARGET, PROJECT, failing), /EACCES/);
});

function event(overrides: Partial<HarnessEvent>): HarnessEvent {
  return {
    provider: "antigravity",
    event: "tool.before",
    sessionKey: "antigravity-s",
    projectDir: PROJECT,
    toolName: "Write",
    filePath: TARGET,
    raw: {},
    ...overrides,
  };
}

const TARGETS = [TARGET, "C:\\w\\.agents\\hooks.json", "C:\\Users\\dev\\.cursor\\hooks.json"];

test("path alias: the match leaves every event outside tool.before with Write, Edit or MultiEdit on Windows", () => {
  const alias = `\\\\?\\${TARGET}`;
  const cases: Partial<HarnessEvent>[] = [
    { event: "read.before", toolName: "Read", filePath: alias },
    { event: "edit.after", toolName: "Write", filePath: alias },
    { toolName: "Read", filePath: alias },
    { toolName: "Task", filePath: alias },
    { toolName: undefined, filePath: alias },
    { filePath: undefined },
  ];
  for (const overrides of cases) {
    assert.equal(
      antigravityCanonicalWiringMatch(event(overrides), TARGETS, plainDisk),
      null,
      JSON.stringify(overrides),
    );
  }
  assert.equal(
    antigravityCanonicalWiringMatch(event({ filePath: alias }), TARGETS, { ...plainDisk, platform: "linux" }),
    null,
  );
});

test("path alias: an alias of a protected target matches, with both sides canonical", () => {
  for (const toolName of ["Write", "Edit", "MultiEdit"]) {
    for (const alias of [
      `\\\\?\\${TARGET}`,
      `\\\\.\\${TARGET}`,
      `${TARGET}::$DATA`,
      `${TARGET}.`,
      `${TARGET} `,
    ]) {
      assert.deepEqual(
        antigravityCanonicalWiringMatch(event({ toolName, filePath: alias }), TARGETS, plainDisk),
        {
          filePath: TARGET,
          protectedPaths: TARGETS,
        },
      );
    }
  }
});

test("path alias: a junction in the protected target's own ancestor matches a TargetFile written through its destination", () => {
  const { deps } = disk(
    ["C:\\", "C:\\Users", "C:\\Users\\dev", "E:\\", "E:\\profiles", "E:\\profiles\\dev"],
    {
      "C:\\Users\\dev": "E:\\profiles\\dev",
    },
  );
  const match = antigravityCanonicalWiringMatch(
    event({ filePath: "E:\\profiles\\dev\\.gemini\\config\\hooks.json" }),
    [TARGET],
    deps,
  );
  assert.deepEqual(match, {
    filePath: "E:\\profiles\\dev\\.gemini\\config\\hooks.json",
    protectedPaths: ["E:\\profiles\\dev\\.gemini\\config\\hooks.json"],
  });
});

test("path alias: on Windows a match ignores case, in a segment that does not exist yet, and keeps each side's case", () => {
  const { deps } = disk(["C:\\", "C:\\w"]);
  const target = "C:\\w\\.agents\\hooks.json";
  const alias = "C:\\w\\.AGENTS\\Hooks.JSON";
  assert.deepEqual(antigravityCanonicalWiringMatch(event({ filePath: alias }), [target], deps), {
    filePath: alias,
    protectedPaths: [target],
  });
});

test("path alias: no match leaves the raw inputs", () => {
  assert.equal(
    antigravityCanonicalWiringMatch(event({ filePath: "C:\\w\\src\\a.ts" }), TARGETS, plainDisk),
    null,
  );
  assert.equal(
    antigravityCanonicalWiringMatch(event({ filePath: `${TARGET}:named` }), TARGETS, plainDisk),
    null,
    "a named stream is another stream, not an alias",
  );
});

test("path alias: a realpath failure on a protected target is thrown out of the match", () => {
  const failing = {
    ...plainDisk,
    realpath: (path: string) => {
      if (path.includes(".cursor")) {
        throw new Error("EPERM: realpath refused");
      }
      return path;
    },
  };
  assert.throws(() => antigravityCanonicalWiringMatch(event({}), TARGETS, failing), /EPERM/);
});
