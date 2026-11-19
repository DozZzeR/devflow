/** @file Build the standalone CLI and plugin manifests distributed to both hosts. */

// Build the Claude Code and Codex plugins from one source:
//   skills/            -> <plugin>/skills/ (copied unchanged)
//   src/cli.ts bundle  -> <plugin>/bin/devflow.mjs (esbuild, all dependencies inlined)
//   manifests and .mcp.json per client
// Usage: node scripts/build-plugins.mjs [outDir]   (default: ./plugins)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve inputs relative to the script so builds also work from another directory. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Destination rebuilt by this invocation, optionally supplied as the first CLI argument. */
const out = resolve(process.argv[2] ?? join(repo, "plugins"));
/** Package metadata used to stamp both plugin manifests and the bundled CLI. */
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

/** Shared plugin description shown by both hosts. */
const description = "Role-separated, multi-model development workflow with deterministic gates and OpenSpec-format plans.";
/** Manifest attribution for the two generated distributions. */
const author = { name: "DozZzeR" };

if (existsSync(out)) {
  const entries = readdirSync(out).filter((e) => e !== ".bundle");
  if (entries.some((e) => e !== "claude" && e !== "codex")) {
    console.error(`Refusing to replace ${out}: it contains files that are not generated plugins.`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });

// One bundle, written once and copied into both plugins.
/** Temporary output shared by both plugin layouts during one build. */
const bundleDir = join(out, ".bundle");
await build({
  entryPoints: [join(repo, "src", "cli.ts")],
  outfile: join(bundleDir, "devflow.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  define: { __DEVFLOW_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "import { createRequire as __devflowRequire } from 'node:module'; const require = __devflowRequire(import.meta.url);" },
});

/** Populate a vendor's plugin directory with the bundled executable and canonical skills. */
function layout(client) {
  const dir = join(out, client, "devflow");
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(join(bundleDir, "devflow.mjs"), join(dir, "bin", "devflow.mjs"));
  cpSync(join(repo, "skills"), join(dir, "skills"), { recursive: true });
  return dir;
}

/** Serialize manifest objects with stable indentation and a trailing newline. */
const json = (v) => JSON.stringify(v, null, 2) + "\n";

// Claude Code
/** Destination for the Claude plugin manifest and MCP configuration. */
const claude = layout("claude");
mkdirSync(join(claude, ".claude-plugin"), { recursive: true });
writeFileSync(join(claude, ".claude-plugin", "plugin.json"), json({
  name: "devflow",
  version: pkg.version,
  description,
  author,
  repository: "https://github.com/DozZzeR/devflow",
  keywords: ["workflow", "openspec", "multi-model", "tdd"],
}));
writeFileSync(join(claude, ".mcp.json"), json({
  mcpServers: { devflow: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/devflow.mjs", "mcp"] } },
}));

// Codex
/** Destination for the Codex plugin manifest and per-tool approval settings. */
const codex = layout("codex");
mkdirSync(join(codex, ".codex-plugin"), { recursive: true });
writeFileSync(join(codex, ".codex-plugin", "plugin.json"), json({
  name: "devflow",
  version: pkg.version,
  description,
  author,
  repository: "https://github.com/DozZzeR/devflow",
  keywords: ["workflow", "openspec", "multi-model", "tdd"],
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  interface: { displayName: "devflow", shortDescription: "Role-separated dev workflow with gates" },
}));
// Read-only tools run without a prompt; tools that record decisions or start work keep Codex's confirmation.
/** MCP tools that the generated Codex configuration allows without an approval prompt. */
const readOnly = ["devflow_status", "devflow_nodes", "devflow_next", "devflow_run_status", "devflow_job_status", "devflow_log", "devflow_roles"];
writeFileSync(join(codex, ".mcp.json"), json({
  mcpServers: {
    devflow: {
      command: "node",
      args: ["./bin/devflow.mjs", "mcp"],
      cwd: ".",
      tools: Object.fromEntries(readOnly.map((t) => [t, { approval_mode: "approve" }])),
    },
  },
}));

rmSync(bundleDir, { recursive: true, force: true });
console.log(`plugins written to ${out}`);
