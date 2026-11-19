/** @file Respond to role prompts with deterministic artifacts and configurable failure outcomes. */

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

/** Create parent directories and write an artifact for this fake agent run. */
const write = (p, text) => {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, text);
};

/** Accumulate the model prompt from stdin before selecting scripted role behavior. */
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
  const role = (/You are the (\w+)(?: \(small task\))? role/.exec(prompt) || [])[1];
  if (role && role === env.FAKE_LIMIT_ROLE) {
    switch (env.FAKE_LIMIT_OUTPUT) {
      case "claude-usage":
        console.log(JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "Usage limit reached, resets 5pm" }));
        process.exit(0);
      case "claude-429":
        console.log(JSON.stringify({ type: "result", is_error: true, api_error_status: 429 }));
        process.exit(0);
      case "codex":
        console.error("ERROR: You've hit your usage limit. Try again at 5:00 PM.");
        process.exit(1);
    }
  }
  if (role === "IMPLEMENT" && env.FAKE_IMPLEMENT_TOUCH) {
    const split = env.FAKE_IMPLEMENT_TOUCH.indexOf("=");
    if (split < 0) fs.rmSync(env.FAKE_IMPLEMENT_TOUCH, { force: true });
    else write(env.FAKE_IMPLEMENT_TOUCH.slice(0, split), env.FAKE_IMPLEMENT_TOUCH.slice(split + 1));
  }
  if (env.FAKE_FAIL_ROLE && role === env.FAKE_FAIL_ROLE) process.exit(3);

  if (prompt.includes("You are the REVIEW role")) {
    console.log("reviewing the plan");
    console.log(env.FAKE_REVIEW || "APPROVE");
  } else if (prompt.includes("You are the EXPLORE role")) {
    write(`.devflow/runs/${id}/facts.md`, "## Relevant code\n- src/math.js\n");
  } else if (prompt.includes("Write the replacement node to node.md")) {
    write("node.md", "- [ ] 1.1 Check negative input with node check.js\n");
  } else if (prompt.includes("You are the DESIGN role")) {
    const dir = `openspec/changes/${id}`;
    write(`${dir}/proposal.md`, "# Proposal\n\n## Why\n\nNeed mul.\n\n## What Changes\n\n- Add mul.\n\n## Capabilities\n\n### New Capabilities\n\n- `math`: arithmetic.\n\n### Modified Capabilities\n\nNone.\n\n## Impact\n\n- src/math.js\n");
    write(`${dir}/design.md`, "# Design\n\n## Context\n\nSmall.\n\n## Decisions\n\nSECRET-DESIGN-REASONING: use a loop.\n\n## Impact zone\n\n- `src/**`\n- `tests/**`\n\n## Test plan\n\n- tests/mul.test.js checks mul(2,3) = 6.\n");
    write(`${dir}/tasks.md`, "# Tasks\n\n## 1. Mul\n\n- [ ] 1.1 Add mul and its test; verify with node check.js\n");
    write(`${dir}/specs/math/spec.md`, "## Purpose\n\nArithmetic helpers.\n\n## ADDED Requirements\n\n### Requirement: Multiply\n\nThe system SHALL multiply two numbers.\n\n#### Scenario: Two and three\n\n- **WHEN** mul(2, 3) is called\n- **THEN** it returns 6\n");
  } else if (prompt.includes("You are the IMPLEMENT") && env.FAKE_BLOCKED) {
    console.log(`BLOCKED: ${env.FAKE_BLOCKED}`);
  } else if (prompt.includes("You are the IMPLEMENT") && env.FAKE_PLAN_CONFLICT) {
    console.log("The plan contradicts the finding.");
    console.log(`PLAN CONFLICT: ${env.FAKE_PLAN_CONFLICT}`);
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
    const verdict = `VERDICT: ${env.FAKE_VERDICT || "PASS"}\n\ndesign-visible: ${designVisible}\nreasoning-in-prompt: ${leaked}\n`;
    // Like `claude -p --output-format json` when the model answers instead of writing the file.
    if (env.FAKE_VERDICT_IN_ANSWER) console.log(JSON.stringify({ type: "result", result: `Checked.\n\n**${verdict.replace("\n", "**\n")}` }));
    else write(".devflow-verdict.md", verdict);
  }
  console.log("fake agent done");
  if (env.FAKE_AGENT_SLEEP) setTimeout(() => process.exit(0), Number(env.FAKE_AGENT_SLEEP));
  else process.exit(0);
});
