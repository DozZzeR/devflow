import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { openLog, redact } from "../src/logs.js";
import { DevflowError } from "../src/errors.js";
import { tempDir } from "./helpers.js";

const reason = (r: string) => (e: unknown) => e instanceof DevflowError && e.reason === r;

test("redaction masks keys and tokens", () => {
  const text = [
    "key sk-ant-api03-abcdefghijklmnop",
    "openai sk-proj-1234567890abcdefXYZ",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc",
    '"api_key": "supersecretvalue123"',
    "token=abcdefgh12345678",
    "normal line with sk- prefix short",
  ].join("\n");
  const r = redact(text);
  assert.ok(!/abcdefghijklmnop|1234567890abcdef|eyJhbGci|supersecretvalue|abcdefgh12345678/.test(r), r);
  assert.match(r, /Bearer \[REDACTED\]/);
  assert.match(r, /normal line with sk- prefix short/);
});

test("logs are created exclusively with increasing numbers and redacted on write", () => {
  const root = tempDir();
  const a = openLog(root, "verify", "t1");
  a.write("Authorization: Bearer abcdefghijkl\npartial");
  a.close();
  const b = openLog(root, "verify", "t1");
  b.close();
  assert.deepEqual([basename(a.path), basename(b.path)], ["verify-1.log", "verify-2.log"]);
  assert.equal(readFileSync(a.path, "utf8"), "Authorization: Bearer [REDACTED]\npartial");
});

test("task ids that escape are rejected and nothing is created", () => {
  const root = tempDir();
  assert.throws(() => openLog(root, "verify", "../x"), reason("invalid_id"));
});

test("a linked runs directory is refused", (t) => {
  const root = tempDir();
  const outside = tempDir();
  mkdirSync(join(root, ".devflow"));
  try {
    symlinkSync(outside, join(root, ".devflow", "runs"), "junction");
  } catch {
    t.skip("cannot create links here");
    return;
  }
  assert.throws(() => openLog(root, "verify", "t1"), reason("unsafe_path"));
});
