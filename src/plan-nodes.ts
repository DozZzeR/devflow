import { DevflowError } from "./errors.js";

const checkbox = /^([ \t]*[-*+] \[([ xX])\] (\d+(?:\.\d+)+)\s+\S.*)$/;
const invalid = (message: string) => new DevflowError("invalid_plan_nodes", message);

/* Mask fenced examples without shifting Markdown offsets. */
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

export interface ReviewDecision {
  finding: string;
  action: "fix" | "defer" | "dismiss";
  node: string;
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

/** Refuse incomplete or invented decisions instead of silently dropping a review finding. */
export function decidedFeedback(rows: ReviewDecision[], verdict: string): string {
  const ids = [...prose(verdict).matchAll(/^(\d+)[.)]\s+\S/gm)].map(m => "F" + m[1]);
  if (!ids.length || ids.length !== rows.length || rows.some(r => !ids.includes(r.finding))) {
    throw invalid("Decide each numbered finding of this verify round exactly once.");
  }
  return rows.map(r => r.finding + " | " + r.action + " | " + r.node + " | " + r.reason).join("\n");
}
