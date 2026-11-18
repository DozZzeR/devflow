import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { matchesAny } from "./glob.js";

/** What a run may do; written by the claude runner, read by the hook. */
export const ScopeSchema = z.strictObject({
  root: z.string(),
  write: z.array(z.string()),
  bash: z.array(z.string()),
});
export type Scope = z.infer<typeof ScopeSchema>;

/** Tools that cannot change the filesystem or run commands. Anything not listed here or below is denied. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch"]);
const PATH_KEYS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export type Decision = { allow: true } | { allow: false; reason: string };

export function decide(scope: Scope, toolName: string, toolInput: Record<string, unknown>): Decision {
  if (READ_ONLY_TOOLS.has(toolName)) return { allow: true };

  const pathKey = PATH_KEYS[toolName];
  if (pathKey) {
    const raw = toolInput[pathKey];
    if (typeof raw !== "string" || !raw) return { allow: false, reason: `${toolName} without a path` };
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(scope.root, raw);
    const rel = relative(resolve(scope.root), abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      return { allow: false, reason: `devflow: ${raw} is outside the project` };
    }
    if (!matchesAny(rel, scope.write)) {
      return { allow: false, reason: `devflow: ${rel.replace(/\\/g, "/")} is outside this role's write scope` };
    }
    return { allow: true };
  }

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command.trim() : "";
    if (scope.bash.includes(command)) return { allow: true };
    return { allow: false, reason: `devflow: shell command not allowed for this role: ${command || "(empty)"}` };
  }

  return { allow: false, reason: `devflow: tool ${toolName} is not allowed for this role` };
}

/** Claude Code PreToolUse hook entry point: reads the event JSON on stdin, prints a decision. */
export function runHook(scopeFile: string, stdinText: string): string {
  const scope = ScopeSchema.parse(JSON.parse(readFileSync(scopeFile, "utf8")));
  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(stdinText) as typeof event;
  } catch {
    return deny("devflow: unreadable hook input");
  }
  const tool = typeof event.tool_name === "string" ? event.tool_name : "";
  const input = event.tool_input && typeof event.tool_input === "object" ? (event.tool_input as Record<string, unknown>) : {};
  const d = decide(scope, tool, input);
  return d.allow
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })
    : deny(d.reason);
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}
