// Focused test run: compile the project, then run `node --test` on only the given test files.
// Usage: node scripts/test-focused.mjs test/<name>.test.ts [more files...]
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const files = process.argv.slice(2);
const valid = (f) =>
  /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(f) &&
  // Only test sources: a src/ file compiles to a module, not to a test, so running it proves nothing.
  f.startsWith("test/") &&
  f.endsWith(".test.ts") &&
  !f.split("/").some((s) => s === "" || s === "." || s === "..");

if (!files.length) {
  console.error("test-focused: no test files given");
  process.exit(2);
}
for (const f of files) {
  if (!valid(f)) {
    console.error(`test-focused: unsupported argument "${f}" (expected a relative test/**/*.test.ts path)`);
    process.exit(2);
  }
  let isFile = false;
  try {
    isFile = statSync(f).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    console.error(`test-focused: unsupported argument "${f}" (not an existing regular file)`);
    process.exit(2);
  }
}

const require = createRequire(import.meta.url);
let manifestPath;
try {
  manifestPath = require.resolve("typescript/package.json");
} catch {
  console.error("test-focused: cannot resolve typescript/package.json; run npm ci");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const binTsc = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
if (typeof binTsc !== "string") {
  console.error("test-focused: typescript/package.json has no bin.tsc entry");
  process.exit(2);
}
const tscPath = path.resolve(path.dirname(manifestPath), binTsc);

const build = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.json"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const mapped = files.map((f) => `dist/${f.slice(0, -3)}.js`);
const run = spawnSync(process.execPath, ["--test", ...mapped], { stdio: "inherit" });
process.exit(run.status ?? 1);
