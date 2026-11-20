/** @file Match a role's shell command against the focused test command template without a shell. */

import { matchesAny } from "./glob.js";

/** Characters a focused file token may contain: no whitespace, quote, glob, shell metacharacter or leading dash. */
export const FOCUSED_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
/** Largest number of files one focused command may name. */
export const MAX_FOCUSED_FILES = 64;
/** Placeholder that stands for the space-separated test files in a focused template. */
export const FOCUSED_PLACEHOLDER = "{files}";

/** The focused template and the globs every file argument must match. */
export interface FocusedScope {
  /** Command text with exactly one `{files}` placeholder; trusted configuration. */
  template: string;
  /** Project-relative globs (`test.paths`) the files must match. */
  paths: string[];
}

/** Accept a token that is a plain relative path without `.`, `..` or empty segments and that matches the globs. */
function safeToken(token: string, paths: readonly string[]): boolean {
  if (!FOCUSED_TOKEN.test(token)) return false;
  if (token.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return matchesAny(token, paths);
}

/**
 * Check a command against the focused template. The command must be the template with `{files}` replaced by
 * one or more safe tokens separated by single spaces.
 * @returns The files named by the command, or undefined when the command is not an allowed focused command.
 */
export function matchFocused(command: string, focused: FocusedScope): string[] | undefined {
  const at = focused.template.indexOf(FOCUSED_PLACEHOLDER);
  if (at < 0 || focused.template.indexOf(FOCUSED_PLACEHOLDER, at + 1) >= 0) return undefined;
  const prefix = focused.template.slice(0, at);
  const suffix = focused.template.slice(at + FOCUSED_PLACEHOLDER.length);
  const text = command.trim();
  if (text.length < prefix.length + suffix.length || !text.startsWith(prefix) || !text.endsWith(suffix)) return undefined;
  const middle = text.slice(prefix.length, text.length - suffix.length);
  if (!middle) return undefined;
  const files = middle.split(" ");
  if (files.length > MAX_FOCUSED_FILES) return undefined;
  return files.every((file) => safeToken(file, focused.paths)) ? files : undefined;
}
