/** @file Classify subscription-limit evidence in vendor output for the pause and retry path. */

/** Vendor and optional provider-provided reset information for a paused role. */
export interface UsageLimit {
  /** CLI whose output indicated a usage limit. */
  runner: "claude" | "codex";
  /** Reported reset text or normalized vendor timestamp when available. */
  reset?: string;
}

/** Extract a reset phrase of up to 100 characters, preserving internal periods and dotted abbreviations. */
function resetText(text: string): string | undefined {
  const phrase = /\b(?:resets|try again (?:at|in))\b([^\r\n|]*)/i.exec(text)?.[1]?.trim();
  if (!phrase) return undefined;

  const words = phrase.split(/\s+/);
  const end = words.findIndex((word) => word.endsWith("."));
  if (end >= 0) {
    words.length = end + 1;
    const last = words[end]!;
    if (!/^(?:[a-z]\.){2,}$/i.test(last)) words[end] = last.slice(0, -1);
  }
  return words.join(" ").trim().slice(0, 100) || undefined;
}

/** Inspect Claude result objects or the tail of an unsuccessful Codex run for usage-limit evidence. */
export function detectUsageLimit(runner: string, logText: string, exitCode: number | null): UsageLimit | undefined {
  // A killed or timed-out process (null exit) did not end on the provider limit, whatever it printed before.
  if (exitCode === null) return undefined;
  if (runner === "claude") {
    for (const line of logText.trimEnd().split(/\r?\n/).reverse()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const result = value as Record<string, unknown>;
      if (result.api_error_status !== 429 && result.api_error !== "usage_limit_reached") return undefined;
      const message = typeof result.result === "string" ? result.result : "";
      const epoch = /\|(\d+)$/.exec(message)?.[1];
      const date = epoch === undefined ? undefined : new Date(Number(epoch) * 1000);
      const reset = date && Number.isFinite(date.getTime()) ? date.toISOString() : resetText(message);
      return reset === undefined ? { runner } : { runner, reset };
    }
  }
  if (runner === "codex" && typeof exitCode === "number" && exitCode !== 0) {
    const tail = logText.replace(/\r?\n$/, "").split(/\r?\n/).slice(-50);
    const isLimit = (line: string) => /error/i.test(line) && /usage limit|\b429\b/i.test(line);
    const index = tail.findLastIndex(isLimit);
    if (index >= 0) {
      // Read the reset from the first limit line of the same error block; a blank line ends the previous block.
      const blockStart = tail.slice(0, index).findLastIndex((line) => !line.trim()) + 1;
      const first = blockStart + tail.slice(blockStart, index + 1).findIndex(isLimit);
      const block = tail.slice(first, index + 10);
      const blank = block.findIndex((line) => !line.trim());
      if (blank >= 0) block.length = blank;
      const reset = resetText(block.join("\n"));
      return reset === undefined ? { runner } : { runner, reset };
    }
  }
  return undefined;
}
