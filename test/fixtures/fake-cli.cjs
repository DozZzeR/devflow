// Fake `claude` / `codex` for tests. Behaviour is driven by FAKE_* environment variables.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-cli 1.0.0");
  process.exit(0);
}
if ((args[0] === "login" || args[0] === "auth") && args[1] === "status") {
  console.log("Logged in (fake)");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const env = process.env;
  if (env.FAKE_RECORD) {
    fs.writeFileSync(
      env.FAKE_RECORD,
      JSON.stringify({ args, stdin, cwd: process.cwd(), envKeys: Object.keys(env).sort() }),
    );
  }
  for (const file of (env.FAKE_WRITE || "").split(";").filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, "written by fake " + Date.now() + "\n");
  }
  if (env.FAKE_PRINT) console.log(env.FAKE_PRINT);
  if (env.FAKE_GRANDCHILD) {
    const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    fs.writeFileSync(env.FAKE_GRANDCHILD, String(g.pid));
  }
  const exit = () => process.exit(Number(env.FAKE_EXIT || 0));
  if (env.FAKE_SLEEP) setTimeout(exit, Number(env.FAKE_SLEEP));
  else exit();
});
