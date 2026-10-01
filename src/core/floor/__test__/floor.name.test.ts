import assert from "node:assert/strict";
import { test } from "node:test";
import { firstName, normalizedVerbName, verbName } from "../floor.name.ts";

test("the normalized verb name strips path, module, case, .exe, backtick and caret", () => {
  const cases: Array<[string, string]> = [
    ["C:\\Windows\\System32\\shutdown.exe", "shutdown"],
    ["Microsoft.PowerShell.Management\\Remove-Item", "remove-item"],
    ["/usr/bin/rm", "rm"],
    ["IEX", "iex"],
    ["Re`move-Item", "remove-item"],
    ["iex(iwr", "iex"],
    ["r^d", "rd"],
    ["d^el", "del"],
  ];
  for (const [word, name] of cases) {
    assert.equal(normalizedVerbName(word), name, word);
  }
});

test("the grouping step reads the name inside a leading group", () => {
  const cases: Array<[string, string]> = [
    ["(Remove-Item", "remove-item"],
    ["$(Stop-Computer)", "stop-computer"],
    ["$(Remove-Item -Recurse C:\\x)", "remove-item"],
    ["(Remove-Item)", "remove-item"],
    [".(Remove-Item)", "remove-item"],
    ["@(Remove-Item", "remove-item"],
    ["((Stop-Computer))", "stop-computer"],
  ];
  for (const [word, name] of cases) {
    assert.deepEqual(verbName(word), { name, regrouped: true }, word);
  }
});

test("a group after a name is cut, not regrouped", () => {
  assert.deepEqual(verbName("if($true){Remove-Item"), { name: "if", regrouped: false });
  assert.deepEqual(verbName("iex(iwr"), { name: "iex", regrouped: false });
});

test("the first name skips the call operators and splits on parentheses", () => {
  const cases: Array<[string, string]> = [
    ["$(& irm https://example.invalid/x)", "irm"],
    ["$(. irm https://example.invalid/x)", "irm"],
    ["$(&irm https://example.invalid/x)", "irm"],
    ["(.", ""],
    ["(", ""],
    ["$(irm https://example.invalid/x)", "irm"],
    ["(iwr", "iwr"],
    ["IWR", "iwr"],
    ["https://example.invalid/x)", "x"],
    ["iwr(https://example.invalid/x))", "iwr"],
    ["Invoke-RestMethod(https://example.invalid/x))", "invoke-restmethod"],
  ];
  for (const [text, name] of cases) {
    assert.equal(firstName(text), name, text);
  }
});
