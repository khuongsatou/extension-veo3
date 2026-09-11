const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.resolve(
  __dirname,
  "..",
  ".github",
  "workflows",
  "release-extension.yml",
);

test("manual release workflow validates, packages, uploads, and publishes in order", () => {
  const source = fs.readFileSync(workflowPath, "utf8");

  assert.match(source, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(source, /^  (push|pull_request|schedule):/m);
  assert.match(source, /^permissions:\n  contents: write$/m);
  assert.match(source, /actions\/checkout@v7/);
  assert.match(source, /actions\/setup-node@v7/);
  assert.match(source, /node-version: 24/);
  assert.match(
    source,
    /node --test tests\/release-package\.test\.cjs tests\/release-workflow\.test\.cjs/,
  );
  assert.match(source, /node scripts\/package-release\.mjs/);
  assert.match(source, /actions\/upload-artifact@v7/);
  assert.match(source, /if-no-files-found: error/);
  assert.match(source, /gh release view/);
  assert.match(source, /git ls-remote --exit-code --tags/);
  assert.match(source, /gh release create/);
  assert.doesNotMatch(source, /secrets\./);

  const testStep = source.indexOf("node --test");
  const packageStep = source.indexOf("node scripts/package-release.mjs");
  const uploadStep = source.indexOf("actions/upload-artifact@v7");
  const publishStep = source.indexOf("gh release create");
  assert.ok(testStep < packageStep, "tests must run before packaging");
  assert.ok(packageStep < uploadStep, "packaging must run before artifact upload");
  assert.ok(uploadStep < publishStep, "artifact upload must finish before release publish");
});
