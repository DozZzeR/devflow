// Build the Claude Code and Codex plugins from one source:
//   skills/            -> <plugin>/skills/ (copied unchanged)
//   src/cli.ts bundle  -> <plugin>/bin/devflow.mjs (esbuild, all dependencies inlined)
//   manifests and .mcp.json per client
// Usage: node scripts/build-plugins.mjs [outDir]   (default: ./plugins)
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(repo, "plugins"));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

const description = "Role-separated, multi-model development workflow with deterministic gates and OpenSpec-format plans.";
const author = { name: "DozZzeR" };

rmSync(out, { recursive: true, force: true });

// One bundle, written once and copied into both plugins.
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

function layout(client) {
  const dir = join(out, client, "devflow");
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(join(bundleDir, "devflow.mjs"), join(dir, "bin", "devflow.mjs"));
  cpSync(join(repo, "skills"), join(dir, "skills"), { recursive: true });
  return dir;
}

const json = (v) => JSON.stringify(v, null, 2) + "\n";

// Claude Code
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
const readOnly = ["devflow_status", "devflow_next", "devflow_run_status", "devflow_job_status", "devflow_log", "devflow_roles"];
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
