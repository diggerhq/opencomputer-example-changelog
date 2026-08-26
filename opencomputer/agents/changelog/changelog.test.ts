import assert from "node:assert/strict";
import test from "node:test";
import {
  branchName,
  changelogPath,
  evidenceWindow,
  insertEntry,
  repositoryName,
  validateEntry,
} from "./changelog.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("normalizes one repository and rejects path-like repository input", () => {
  assert.equal(repositoryName("Acme/Widgets"), "acme/widgets");
  assert.throws(() => repositoryName("acme/widgets/other"), /owner\/repository/);
});

test("accepts only a repository-relative Markdown changelog path", () => {
  assert.equal(changelogPath("docs/CHANGELOG.md"), "docs/CHANGELOG.md");
  assert.throws(() => changelogPath("../CHANGELOG.md"), /repository-relative/);
  assert.throws(() => changelogPath("CHANGELOG.txt"), /Markdown/);
});

test("derives a deterministic bounded evidence window", () => {
  assert.deepEqual(evidenceWindow("2026-08-26T16:00:00Z", 48), {
    start: "2026-08-24T16:00:00.000Z",
    end: "2026-08-26T16:00:00.000Z",
    lookbackHours: 48,
  });
  assert.throws(() => evidenceWindow("2026-08-26T16:00:00Z", 73), /1 to 72/);
});

test("prepends a bounded section while preserving existing changelog content", () => {
  const result = insertEntry(
    "# Changelog\n\n## 2026-08-20\n\n- Existing entry.\n",
    "## 2026-08-26\n\n- Added durable schedules.",
    SHA,
  );
  assert.equal(result.duplicate, false);
  assert.match(result.content, /^# Changelog\n\n## 2026-08-26/);
  assert.match(result.content, /## 2026-08-20\n\n- Existing entry\./);
});

test("detects the exact base marker without changing content", () => {
  const original = `# Changelog\n\n## 2026-08-26\n\n- Entry.\n\n<!-- opencomputer-changelog:${SHA} -->\n`;
  assert.deepEqual(insertEntry(original, "## Retry\n\n- Entry.", SHA), {
    content: original,
    duplicate: true,
  });
});

test("rejects malformed entries and creates deterministic branch names", () => {
  assert.throws(() => validateEntry("- no heading"), /H2/);
  assert.equal(branchName(SHA), "opencomputer/changelog-0123456789ab");
});
