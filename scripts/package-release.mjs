import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_DIRECTORIES = ["_metadata", "assets", "side_panel_styles", "split-source"];
const ROOT_RUNTIME_PATTERN = /\.(?:css|html|js|json)$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`${command} failed: ${detail}`);
  }
  return result.stdout;
}

function safeRuntimePath(relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  if (normalized.includes("*")) return null;
  return normalized;
}

export function parseManifest(rootDir) {
  const manifestPath = path.join(rootDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!VERSION_PATTERN.test(String(manifest.version || ""))) {
    throw new Error("manifest.json must contain an x.y.z version");
  }
  return manifest;
}

export function collectRuntimePaths(rootDir) {
  const rootFiles = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ROOT_RUNTIME_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const directories = RUNTIME_DIRECTORIES.filter((entry) => existsSync(path.join(rootDir, entry)));
  const runtimePaths = [...rootFiles, ...directories].sort();
  if (!runtimePaths.includes("manifest.json")) {
    throw new Error("manifest.json is missing from release runtime paths");
  }
  return runtimePaths;
}

export function manifestRuntimePaths(manifest) {
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

export async function buildReleasePackage({ rootDir, outputDir }) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedOutput = path.resolve(outputDir);
  const manifest = parseManifest(resolvedRoot);
  const version = manifest.version;
  const tag = `v${version}`;
  const zipName = `veo3-kit-extension-${tag}.zip`;
  const zipPath = path.join(resolvedOutput, zipName);
  const checksumPath = `${zipPath}.sha256`;
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "veo3-kit-release-"));

  mkdirSync(resolvedOutput, { recursive: true });
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });

  try {
    const runtimePaths = collectRuntimePaths(resolvedRoot);
    run("zip", ["-qr", zipPath, ...runtimePaths], { cwd: resolvedRoot });
    run("unzip", ["-q", zipPath, "-d", extractDir]);

    const packagedManifest = parseManifest(extractDir);
    if (packagedManifest.version !== version) {
      throw new Error(`packaged manifest version mismatch: ${packagedManifest.version}`);
    }

    for (const reference of manifestRuntimePaths(packagedManifest)) {
      const safePath = safeRuntimePath(reference);
      if (!safePath) throw new Error(`unsafe manifest runtime path: ${reference}`);
      if (!existsSync(path.join(extractDir, safePath))) {
        throw new Error(`manifest runtime file is missing: ${safePath}`);
      }
    }

    const checksum = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    writeFileSync(checksumPath, `${checksum}  ${zipName}\n`, "utf8");

    return { version, tag, zipName, zipPath, checksumPath, checksum };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(scriptPath), "..");
  const result = await buildReleasePackage({
    rootDir,
    outputDir: path.join(rootDir, "release"),
  });
  const outputs = {
    version: result.version,
    tag: result.tag,
    zip_name: result.zipName,
    zip_path: path.relative(rootDir, result.zipPath),
    checksum_path: path.relative(rootDir, result.checksumPath),
  };

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""),
      "utf8",
    );
  }

  console.log(`Built ${outputs.zip_name}`);
  console.log(`SHA-256 ${result.checksum}`);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
