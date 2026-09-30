import type { ProviderWiring, WiringEntry } from "../src/contracts/index.ts";

export type CursorHookDef = {
  command: string;
  timeout: number;
  failClosed?: true;
  matcher?: string;
  loop_limit?: number;
};

export type CursorHooksDocument = {
  version: 1;
  hooks: Record<string, CursorHookDef[]>;
};

export function renderCursorHooksDocument(entries: readonly WiringEntry[]): CursorHooksDocument;

export function isCursorWired(targetPath: string): boolean;

export type ApplyOptions = { force?: boolean };

export type CursorApplyResult =
  | { status: "written"; target: string }
  | { status: "unchanged"; target: string }
  | { status: "refused"; target: string; reason: string };

export function applyCursorWiring(wiring: ProviderWiring, options?: ApplyOptions): CursorApplyResult;

export type ClaudeApplyResult =
  | { status: "merged"; target: string }
  | { status: "unchanged"; target: string }
  | { status: "failed"; target: string; reason: string };

export type AntigravityApplyResult =
  | { status: "merged" | "unchanged"; target: string }
  | { status: "failed" | "refused"; target: string; reason: string };

export type ApplyResult = CursorApplyResult | ClaudeApplyResult | AntigravityApplyResult;

export function applyProviderWiring(wiring: ProviderWiring, options?: ApplyOptions): ApplyResult;

export function providerPresencePath(wiring: ProviderWiring): string;

export function isProviderHomePresent(wiring: ProviderWiring): boolean;

export function main(): void;
