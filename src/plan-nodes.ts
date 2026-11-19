/** @file Address OpenSpec checkbox tasks and associate verify findings with approved revision decisions. */

import { DevflowError } from "./errors.js";

/** Recognize a numbered task and capture its checkbox state and stable dotted ID. */
const checkbox = /^([ \t]*[-*+] \[([ xX])\] (\d+(?:\.\d+)+)\s+\S.*)$/;
/** Construct the domain error reported for malformed plan nodes or review decisions. */
const invalid = (message: string) => new DevflowError("invalid_plan_nodes", message);

/** Mask fenced examples without shifting Markdown offsets. */
function prose(markdown: string): string {
  let fence = "";
  return markdown.replace(/^[^\r\n]+/gm, line => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && !mark) return line;
    if (!fence) fence = mark!;
    else if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = "";
    return " ".repeat(line.length);
  });
}

/** Offsets point into the original Markdown, including indented continuation lines. */
export function planNodes(markdown: string) {
  const nodes = new Map<string, { start: number; end: number; done: boolean }>();
  let current: { start: number; end: number; done: boolean } | undefined;
  for (const line of prose(markdown).matchAll(/^([^\r\n]+)(?=\r?$)/gm)) {
    const body = line[1]!;
    const match = checkbox.exec(body);
    if (match) {
      const id = match[3]!;
      if (nodes.has(id)) throw invalid("Duplicate task ID " + id);
      current = { start: line.index, end: line.index + body.length, done: match[2] !== " " };
      nodes.set(id, current);
    } else if (current && /^[ \t]+\S/.test(body)) {
      current.end = line.index + body.length;
    } else {
      current = undefined;
    }
  }
  return nodes;
}

/**
 * Splice a single unchecked node into the original tasks.md, preserving sibling bytes and newline style.
 * @param replacement - One unchecked task with the same ID and optional indented details.
 * @throws DevflowError for ambiguous IDs or a malformed replacement.
 */
export function replaceNode(markdown: string, id: string, replacement: string): string {
  const target = planNodes(markdown).get(id);
  const candidate = replacement.trimEnd().replace(/\r\n/g, "\n");
  const parsed = planNodes(candidate);
  const node = parsed.get(id);
  if (!target || parsed.size !== 1 || !node || node.done || node.start !== 0 || node.end !== candidate.length ||
      candidate.split("\n").slice(1).some(line => line.trim() && !/^[ \t]+/.test(line))) {
    throw invalid("Expected one unchecked task with ID " + id + " and only its indented detail lines.");
  }
  const text = markdown.includes("\r\n") ? candidate.replace(/\n/g, "\r\n") : candidate;
  return markdown.slice(0, target.start) + text + markdown.slice(target.end);
}

/** Disposition of one numbered finding in a particular verify round. */
export interface ReviewDecision {
  /** Round-local finding identifier such as F2. */
  finding: string;
  /** Whether this finding requires implementation, is deferred or is dismissed. */
  action: "fix" | "defer" | "dismiss";
  /** Existing checkbox ID for a fix, or a dash for other decisions. */
  node: string;
  /** Concrete fix instruction or rationale for accepting the finding without a change. */
  reason: string;
}

/** Optional devflow section in a standard OpenSpec tasks.md; all other Markdown is left alone. */
export function reviewDecisions(tasks: string) {
  const rounds = new Map<number, ReviewDecision[]>();
  const nodes = planNodes(tasks);
  let decisions: ReviewDecision[] | undefined;
  for (const line of prose(tasks).split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      decisions = undefined;
      if (!/^## Review decisions\b/i.test(line)) continue;
      const heading = /^## Review decisions \(round ([1-9]\d*)\)\s*$/.exec(line);
      if (!heading || rounds.has(Number(heading[1]))) throw invalid("Invalid or duplicate review decisions heading.");
      decisions = [];
      rounds.set(Number(heading[1]), decisions);
    } else if (decisions && line.trim()) {
      const row = /^- (F[1-9]\d*) \| (fix|defer|dismiss) \| ([\d.]+|-) \| (\S.*)$/.exec(line);
      if (!row || decisions.some(d => d.finding === row[1])) throw invalid("Invalid or duplicate finding: " + line);
      const [, finding, action, node, reason] = row;
      if (action === "fix" ? !nodes.has(node!) : node !== "-") throw invalid("Invalid node for " + finding);
      decisions.push({ finding: finding!, action: action as ReviewDecision["action"], node: node!, reason: reason! });
    }
  }
  return rounds;
}

/** Select the explicit Findings section, or the numbered findings in a pre-section-format report. */
function findingLines(verdict: string): string[] {
  const lines = prose(verdict).split(/\r?\n/);
  const heading = /^ {0,3}#{1,6}[ \t]+/;
  const sections = lines.flatMap((line, i) => /^ {0,3}#{1,6}[ \t]+Findings(?:[ \t]+#+)?[ \t]*$/i.test(line) ? [i] : []);
  if (sections.length > 1) throw new DevflowError("invalid_verdict_findings", "The verdict contains multiple Findings sections.");
  let section: string[];
  if (sections.length) {
    section = lines.slice(sections[0]! + 1);
  } else {
    const testHeading = lines.findIndex(line => /^ {0,3}#{1,6}[ \t]+(?:test(?:s|ing)?|test[- ]run)\b/i.test(line));
    section = testHeading < 0 ? lines : lines.slice(0, testHeading);
    const firstHeading = section.findIndex(line => heading.test(line));
    if (firstHeading >= 0 && !section.slice(0, firstHeading).some(line => /^[1-9]\d*[.)]\s+\S/.test(line))) {
      const firstFinding = section.findIndex(line => /^[1-9]\d*[.)]\s+(?:[*_]{1,2}|\[)?(?:high|medium|low)\b/i.test(line));
      section = firstFinding < 0 ? [] : section.slice(firstFinding);
    }
  }
  const end = section.findIndex(line => heading.test(line));
  return end < 0 ? section : section.slice(0, end);
}

/** Index round-local IDs and their evidence, including indented details and wrapped text. */
function verdictFindings(verdict: string): Map<string, string> {
  const findings = new Map<string, string>();
  let active: string | undefined;
  let paragraphOpen = false;
  for (const line of findingLines(verdict)) {
    const item = /^([1-9]\d*)[.)][ \t]+(\S.*)$/.exec(line);
    if (item) {
      active = "F" + item[1];
      if (findings.has(active)) throw new DevflowError("invalid_verdict_findings", "Duplicate finding " + active + " in the verdict.");
      findings.set(active, item[2]!.trimEnd());
      paragraphOpen = true;
    } else if (!line.trim()) {
      paragraphOpen = false;
    } else if (active && (paragraphOpen || /^[ \t]+\S/.test(line))) {
      findings.set(active, findings.get(active) + "\n" + line.trim());
      paragraphOpen = true;
    } else {
      active = undefined;
    }
  }
  if (!findings.size) throw new DevflowError("invalid_verdict_findings", "Expected numbered entries in the verdict's Findings section.");
  return findings;
}

/**
 * Pair each approved fix with the verifier's original evidence. Include only the decision for deferred
 * or dismissed findings so superseded instructions do not return in implementation or later verification.
 */
export function decidedFeedback(rows: ReviewDecision[], verdict: string): string {
  const findings = verdictFindings(verdict);
  if (rows.length !== findings.size || new Set(rows.map(r => r.finding)).size !== rows.length ||
      rows.some(r => !findings.has(r.finding))) {
    throw invalid("Decide each numbered finding of this verify round exactly once.");
  }
  return rows.map(r => {
    const decision = [r.finding, r.action, r.node, r.reason].join(" | ");
    if (r.action !== "fix") return decision;
    return decision + "\n  Original finding:\n> " + findings.get(r.finding)!.replaceAll("\n", "\n> ");
  }).join("\n");
}
