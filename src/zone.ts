import { readFileSync } from "node:fs";
import { DevflowError } from "./errors.js";
import { matchesAny } from "./glob.js";

/** Same rules as runner write scopes: relative, no "..", no drive prefix. */
export function validateZone(globs: string[]): void {
  for (const g of globs) {
    if (!g || g.startsWith("/") || g.startsWith("\\") || /^[A-Za-z]:/.test(g) || g.includes("..")) {
      throw new DevflowError("invalid_zone", `Zone glob "${g}" must be relative to the project and must not contain "..".`);
    }
  }
}

/** Items of the `## Impact zone` section of a markdown file (list items, backticks stripped). */
export function parseImpactZone(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+impact zone\s*$/i.test(l.trim()));
  if (start < 0) throw new DevflowError("no_zone_section", "No \"## Impact zone\" section found.");
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m) globs.push(m[1]!.replace(/^`|`$/g, "").trim());
  }
  if (!globs.length) throw new DevflowError("no_zone_section", "The \"## Impact zone\" section has no list items.");
  validateZone(globs);
  return globs;
}

export function zoneFromDesign(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new DevflowError("no_design", `Cannot read ${file}.`);
  }
  return parseImpactZone(text);
}

export function outsideZone(changeSet: string[], zone: string[]): string[] {
  return changeSet.filter((p) => !matchesAny(p, zone));
}
