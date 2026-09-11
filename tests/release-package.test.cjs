const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const rootDir = path.resolve(__dirname, "..");

function manifestReferences(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((entry) => [
      ...(entry.js || []),
      ...(entry.css || []),
    ]),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
    ...(manifest.declarative_net_request?.rule_resources || []).map((entry) => entry.path),
  ].filter(Boolean);
}

test("release package is a verified loadable extension with matching checksum", async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "veo3-kit-package-test-"));
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "veo3-kit-extract-test-"));
  t.after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  });

  const moduleUrl = pathToFileURL(path.join(rootDir, "scripts", "package-release.mjs"));
  const { buildReleasePackage } = await import(moduleUrl.href);
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  const result = await buildReleasePackage({ rootDir, outputDir });

  assert.equal(result.version, "0.2.14");
  assert.equal(result.version, manifest.version);
  assert.equal(result.tag, "v0.2.14");
  assert.equal(result.zipName, "veo3-kit-extension-v0.2.14.zip");
  assert.equal(path.basename(result.checksumPath), `${result.zipName}.sha256`);

  const entries = execFileSync("unzip", ["-Z1", result.zipPath], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(entries.includes("manifest.json"));
  assert.ok(entries.includes("background.js"));
  assert.ok(entries.includes("assets/logo.svg"));
  assert.ok(entries.includes("split-source/background.js/part-001.js"));
  assert.equal(entries.some((entry) => entry.startsWith(".github/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("docs/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("scripts/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("tests/")), false);

  execFileSync("unzip", ["-q", result.zipPath, "-d", extractDir]);
  for (const relativePath of manifestReferences(manifest)) {
    assert.equal(
      fs.existsSync(path.join(extractDir, relativePath)),
      true,
      `manifest runtime file is missing: ${relativePath}`,
    );
  }

  const checksumText = fs.readFileSync(result.checksumPath, "utf8");
  assert.match(checksumText, new RegExp(`^[a-f0-9]{64}  ${result.zipName}\\n$`));
  execFileSync("shasum", ["-a", "256", "-c", path.basename(result.checksumPath)], {
    cwd: outputDir,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
});
