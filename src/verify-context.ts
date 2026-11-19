/** @file Resolve the threat model and project guidance that an independent verifier is allowed to see. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, repoInfo } from "./git.js";

/** OpenSpec configuration source preferred for verifier context. */
const YAML_PATH = "openspec/config.yaml";
/** Fallback Markdown context source in the devflow directory. */
const FILE_PATH = ".devflow/context.md";

/** Apply folded-scalar line handling to a supported YAML context value. */
function foldLines(lines: string[]): string {
  let result = "";
  let previous: string | undefined;
  let blankLines = 0;
  for (const line of lines) {
    if (!line) {
      blankLines++;
      continue;
    }
    if (previous !== undefined) {
      const preserveBreaks = /^[ \t]/.test(previous) || /^[ \t]/.test(line);
      result += preserveBreaks ? "\n".repeat(blankLines + 1) : blankLines ? "\n".repeat(blankLines) : " ";
    }
    result += line;
    previous = line;
    blankLines = 0;
  }
  return result;
}

/** Read the top-level `context` key of a YAML text: an inline scalar or a `|` / `>` block scalar. Anything else gives "". */
export function parseContextKey(yaml: string): string {
  const lines = yaml.split(/\r\n?|\n/);
  const i = lines.findIndex((line) => /^context:([ \t]|$)/.test(line));
  if (i < 0) return "";
  const header = lines[i]!.slice("context:".length).trimStart();
  if (header.startsWith('"') || header.startsWith("'")) {
    // Escaped and multiline quoted scalars are outside the supported subset.
    const quoted = /^(?:"([^"\\]*)"|'([^']*)')(?:[ \t]+#.*)?[ \t]*$/.exec(header);
    return (quoted?.[1] ?? quoted?.[2] ?? "").trim();
  }
  const value = header.replace(/(^|[ \t]+)#.*$/, "").trim();
  if (/^[|>][-+]?$/.test(value)) {
    const body: string[] = [];
    let indentation: string | undefined;
    for (const line of lines.slice(i + 1)) {
      if (line && !line.startsWith(" ")) break;
      if (/[^ ]/.test(line)) {
        indentation ??= /^ */.exec(line)![0];
        if (!line.startsWith(indentation)) {
          if (line.trimStart().startsWith("#")) break;
          return "";
        }
      }
      body.push(line);
    }
    if (indentation === undefined) return "";
    const indent = indentation.length;
    const content = body.map((line) => line.slice(indent));
    return (value.startsWith(">") ? foldLines(content) : content.join("\n")).trim();
  }
  if (/^[&*![\]{}|>%@`]/.test(value)) return "";
  // An indented continuation would be a multiline plain scalar.
  const nextContent = lines.slice(i + 1).find((line) => !/^[ \t]*(?:#|$)/.test(line));
  return nextContent && /^[ \t]/.test(nextContent) ? "" : value;
}

/** Text of a source: the base version when the task changed it, otherwise the working-tree file. "" when absent or unreadable. */
function readSource(root: string, base: string, changes: string[], path: string): string {
  try {
    if (changes.includes(path)) {
      const info = repoInfo(root);
      if (!info) return "";
      const r = git(root, ["show", `${base}:${info.prefix}${path}`], { allowFail: true });
      return r.code === 0 ? r.stdout : "";
    }
    const full = join(root, path);
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  } catch {
    return "";
  }
}

/** Threat model for the verifier: openspec/config.yaml `context`, else .devflow/context.md. "" when neither has text. */
export function verificationContext(root: string, base: string, changes: string[]): string {
  const yaml = parseContextKey(readSource(root, base, changes, YAML_PATH));
  if (yaml) return yaml;
  return readSource(root, base, changes, FILE_PATH).trim();
}
