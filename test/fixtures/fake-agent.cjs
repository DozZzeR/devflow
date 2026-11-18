// Fake agent CLI (`codex` / `claude`) for run-loop tests. Reads the devflow prompt from stdin,
// recognises the stage from the role line and writes plausible outputs.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-agent 1.0.0");
  process.exit(0);
}
if ((args[0] === "login" || args[0] === "auth") && args[1] === "status") {
  console.log("Logged in (fake)");
  process.exit(0);
}

const write = (p, text) => {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, text);
};

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const env = process.env;
  const id = (/Task id: (\S+)/.exec(prompt) || [])[1] || "unknown";
  if (env.FAKE_PROMPT_DIR) {
    fs.mkdirSync(env.FAKE_PROMPT_DIR, { recursive: true });
    const role = (/You are the (\w+)/.exec(prompt) || [])[1] || "x";
    fs.writeFileSync(path.join(env.FAKE_PROMPT_DIR, `${role}-${Date.now()}.txt`), prompt);
  }
  if (env.FAKE_FAIL_ROLE && prompt.includes(`You are the ${env.FAKE_FAIL_ROLE} role`)) process.exit(3);

  if (prompt.includes("You are the EXPLORE role")) {
    write(`.devflow/runs/${id}/facts.md`, "## Relevant code\n- src/math.js\n");
  } else if (prompt.includes("You are the DESIGN role")) {
    const dir = `openspec/changes/${id}`;
    write(`${dir}/proposal.md`, "# Proposal\n\n## Why\n\nNeed mul.\n\n## What Changes\n\n- Add mul.\n\n## Capabilities\n\n### New Capabilities\n\n- `math`: arithmetic.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\n- src/math.js\n");
    write(`${dir}/design.md`, "# Design\n\n## Context\n\nSmall.\n\n## Decisions\n\nSECRET-DESIGN-REASONING: use a loop.\n\n## Impact zone\n\n- `src/**`\n- `tests/**`\n\n## Test plan\n\n- tests/mul.test.js checks mul(2,3) = 6.\n");
    write(`${dir}/tasks.md`, "# Tasks\n\n## 1. Mul\n\n- [ ] 1.1 Add mul and its test; verify with node check.js\n");
    write(`${dir}/specs/math/spec.md`, "## Purpose\n\nArithmetic helpers.\n\n## ADDED Requirements\n\n### Requirement: Multiply\n\nThe system SHALL multiply two numbers.\n\n#### Scenario: Two and three\n\n- **WHEN** mul(2, 3) is called\n- **THEN** it returns 6\n");
  } else if (prompt.includes("You are the IMPLEMENT")) {
    write("src/math.js", "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n");
    write("tests/mul.test.js", "const { mul } = require('../src/math'); if (mul(2, 3) !== 6) throw new Error('mul');\n");
    const tasks = `openspec/changes/${id}/tasks.md`;
    if (fs.existsSync(tasks)) write(tasks, fs.readFileSync(tasks, "utf8").replace("- [ ]", "- [x]"));
  } else if (prompt.includes("You are the VERIFY role")) {
    if (env.FAKE_VERIFY_EDIT) write("src/math.js", "// verifier was here\n");
    const designVisible = fs.existsSync(`openspec/changes/${id}/design.md`) ? "yes" : "no";
    const leaked = prompt.includes("SECRET-DESIGN-REASONING") ? "yes" : "no";
    console.log(`git-visible: ${fs.existsSync(".git") ? "yes" : "no"}`);
    write(".devflow-verdict.md", `VERDICT: ${env.FAKE_VERDICT || "PASS"}\n\ndesign-visible: ${designVisible}\nreasoning-in-prompt: ${leaked}\n`);
  }
  console.log("fake agent done");
  if (env.FAKE_AGENT_SLEEP) setTimeout(() => process.exit(0), Number(env.FAKE_AGENT_SLEEP));
  else process.exit(0);
});
