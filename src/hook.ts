import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Resolve links in the nearest existing ancestor, so a linked directory cannot redirect a write. */
function effectivePath(abs: string): string {
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return abs;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ""));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

function outside(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  return !rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..") ? undefined : rel;
}

export function decide(scope: Scope, toolName: string, toolInput: Record<string, unknown>): Decision {
  if (READ_ONLY_TOOLS.has(toolName)) return { allow: true };

  const pathKey = PATH_KEYS[toolName];
  if (pathKey) {
    const raw = toolInput[pathKey];
    if (typeof raw !== "string" || !raw) return { allow: false, reason: `${toolName} without a path` };
    const root = resolve(scope.root);
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
    const rel = outside(root, abs);
    if (rel === undefined) return { allow: false, reason: `devflow: ${raw} is outside the project` };
    const realRoot = existsSync(root) ? realpathSync.native(root) : root;
    const realRel = outside(realRoot, effectivePath(abs));
    if (realRel === undefined || !matchesAny(realRel, scope.write)) {
      return { allow: false, reason: `devflow: ${raw} resolves outside this role's write scope` };
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

/** Claude Code PreToolUse hook entry point: reads the event JSON on stdin, prints a decision. Fails closed. */
export function runHook(scopeFile: string, stdinText: string): string {
  let d: Decision;
  try {
    const scope = ScopeSchema.parse(JSON.parse(readFileSync(scopeFile, "utf8")));
    const event = JSON.parse(stdinText) as { tool_name?: unknown; tool_input?: unknown };
    const tool = typeof event.tool_name === "string" ? event.tool_name : "";
    const input = event.tool_input && typeof event.tool_input === "object" ? (event.tool_input as Record<string, unknown>) : {};
    d = decide(scope, tool, input);
  } catch (e) {
    d = { allow: false, reason: `devflow: hook error, denying: ${(e as Error).message.split(/\r?\n/)[0]}` };
  }
  return d.allow
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })
    : deny(d.reason);
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}
