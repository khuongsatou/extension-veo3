# GitHub Actions Extension Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, validate, upload, and publish a versioned Veo3 Kit ZIP from a manually triggered GitHub Actions workflow.

**Architecture:** A dependency-free Node packaging module owns runtime-file selection, ZIP creation, manifest-reference validation, and SHA-256 generation. A small GitHub Actions workflow calls that module, uploads the resulting files as run artifacts, and creates a GitHub Release only after every gate succeeds.

**Tech Stack:** Node.js 24, Node built-in test runner, system `zip`/`unzip`, GitHub Actions, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-11-github-actions-extension-release-design.md`

## Global Constraints

- Trigger releases only with `workflow_dispatch`.
- Read version exclusively from `manifest.json`.
- Name the tag `v<manifest version>` and ZIP `veo3-kit-extension-v<manifest version>.zip`.
- Publish the ZIP and its `.sha256` sidecar as Actions artifacts and GitHub Release assets.
- Put the loadable extension directly at the ZIP root.
- Exclude `.git/`, `.github/`, `docs/`, `scripts/`, and `tests/` from the ZIP.
- Fail instead of overwriting an existing tag or release.
- Use only `contents: write`; require no external secret.

---

### Task 1: Deterministic release packager

**Files:**
- Create: `tests/release-package.test.cjs`
- Create: `scripts/package-release.mjs`

**Interfaces:**
- Produces: `buildReleasePackage({ rootDir, outputDir }) -> Promise<{ version, tag, zipName, zipPath, checksumPath, checksum }>`.
- Produces CLI outputs `version`, `tag`, `zip_name`, `zip_path`, and `checksum_path` through `$GITHUB_OUTPUT` when invoked directly.
- Consumes: root-level extension `.js`, `.html`, `.css`, and `.json` files plus `_metadata/`, `assets/`, `side_panel_styles/`, and `split-source/`.

- [ ] **Step 1: Write the failing package contract test**

Create a Node test that imports `buildReleasePackage`, packages the real repository into a temporary output directory, lists entries with `unzip -Z1`, and asserts:

```js
assert.equal(result.version, manifest.version);
assert.equal(result.tag, `v${manifest.version}`);
assert.equal(result.zipName, `veo3-kit-extension-v${manifest.version}.zip`);
assert.ok(entries.includes("manifest.json"));
assert.ok(entries.includes("background.js"));
assert.ok(entries.includes("assets/logo.svg"));
assert.ok(entries.includes("split-source/background.js/part-001.js"));
assert.equal(entries.some((entry) => entry.startsWith(".github/")), false);
assert.equal(entries.some((entry) => entry.startsWith("docs/")), false);
assert.match(checksumText, new RegExp(`^[a-f0-9]{64}  ${escapeRegex(result.zipName)}\\n$`));
```

Extract the ZIP and assert that all local paths referenced by `background.service_worker`, `content_scripts`, `side_panel.default_path`, `action.default_popup`, action icons, extension icons, and declarative rule resources exist.

- [ ] **Step 2: Run the package test and verify RED**

Run: `node --test tests/release-package.test.cjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/package-release.mjs`.

- [ ] **Step 3: Implement the minimal packager**

Implement these focused helpers in `scripts/package-release.mjs`:

```js
export function parseManifest(rootDir) { /* read JSON; require x.y.z version */ }
export function collectRuntimePaths(rootDir) { /* approved root files and directories only */ }
export function manifestRuntimePaths(manifest) { /* return referenced local paths */ }
export async function buildReleasePackage({ rootDir, outputDir }) { /* zip, verify, checksum */ }
```

Use `spawnSync("zip", ["-qr", zipPath, ...runtimePaths], { cwd: rootDir })`, extract to `mkdtempSync(path.join(tmpdir(), "veo3-kit-release-"))`, and reject missing or unsafe manifest paths before writing the checksum. Remove only the scoped temporary extraction directory in `finally`.

When the module is the CLI entry point, package from the repository root into `release/`, print a redacted summary, and append exact output values to the file at `process.env.GITHUB_OUTPUT` when present.

- [ ] **Step 4: Run the package test and verify GREEN**

Run: `node --test tests/release-package.test.cjs`

Expected: PASS with one package contract test and no warnings.

- [ ] **Step 5: Commit the packager**

```bash
git add scripts/package-release.mjs tests/release-package.test.cjs
git commit -m "feat: add verified extension release packager"
```

### Task 2: Manual GitHub Actions release workflow

**Files:**
- Create: `tests/release-workflow.test.cjs`
- Create: `.github/workflows/release-extension.yml`

**Interfaces:**
- Consumes: outputs from `node scripts/package-release.mjs` with step id `package`.
- Produces: Actions artifact containing ZIP/checksum and GitHub Release at the derived tag.

- [ ] **Step 1: Write the failing workflow contract test**

Create a static contract test that reads `.github/workflows/release-extension.yml` and asserts the required behavior:

```js
assert.match(source, /workflow_dispatch:/);
assert.match(source, /contents:\s*write/);
assert.match(source, /actions\/checkout@v7/);
assert.match(source, /actions\/setup-node@v7/);
assert.match(source, /node scripts\/package-release\.mjs/);
assert.match(source, /node --test tests\/release-package\.test\.cjs tests\/release-workflow\.test\.cjs/);
assert.match(source, /actions\/upload-artifact@v7/);
assert.match(source, /gh release view/);
assert.match(source, /git ls-remote --exit-code --tags/);
assert.match(source, /gh release create/);
assert.match(source, /permissions:[\s\S]*contents:\s*write/);
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `node --test tests/release-workflow.test.cjs`

Expected: FAIL with `ENOENT` for `.github/workflows/release-extension.yml`.

- [ ] **Step 3: Implement the workflow**

Create `release-extension.yml` with:

```yaml
name: Release Veo3 Kit Extension
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Test release contracts
        run: node --test tests/release-package.test.cjs tests/release-workflow.test.cjs
      - name: Package and verify extension
        id: package
        run: node scripts/package-release.mjs
      - name: Upload workflow artifact
        uses: actions/upload-artifact@v7
        with:
          name: ${{ steps.package.outputs.zip_name }}
          path: |
            ${{ steps.package.outputs.zip_path }}
            ${{ steps.package.outputs.checksum_path }}
          if-no-files-found: error
      - name: Publish GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ steps.package.outputs.tag }}
          ZIP_PATH: ${{ steps.package.outputs.zip_path }}
          CHECKSUM_PATH: ${{ steps.package.outputs.checksum_path }}
        run: |
          if gh release view "$TAG" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
            echo "Release or tag already exists: $TAG"
            exit 1
          fi
          gh release create "$TAG" "$ZIP_PATH" "$CHECKSUM_PATH" --target "$GITHUB_SHA" --title "Veo3 Kit $TAG" --generate-notes
```

- [ ] **Step 4: Run both contract tests and verify GREEN**

Run: `node --test tests/release-package.test.cjs tests/release-workflow.test.cjs`

Expected: PASS with package and workflow contracts green.

- [ ] **Step 5: Commit the workflow**

```bash
git add .github/workflows/release-extension.yml tests/release-workflow.test.cjs
git commit -m "ci: publish extension zip releases"
```

### Task 3: Verify, push, dispatch, and audit release

**Files:**
- Modify: none expected
- Verify: local repository, GitHub Actions run, and GitHub Release assets

**Interfaces:**
- Consumes: committed workflow on `main`.
- Produces: successful Actions run and GitHub Release `v0.2.14` with two verified assets.

- [ ] **Step 1: Run the full local release gate**

```bash
find . -type f -name '*.js' -not -path './.git/*' -print0 | xargs -0 -n1 node --check
node --test tests/*.test.cjs
node scripts/package-release.mjs
git diff --check
git status --short
```

Expected: syntax checks and tests pass, package verification succeeds, diff check is clean, and only the ignored/untracked local `release/` output is absent from the commit set.

- [ ] **Step 2: Ensure generated release output is not committed**

Add `release/` to `.git/info/exclude` so local verification artifacts stay local without changing extension runtime contents. Confirm `git status --short` is clean.

- [ ] **Step 3: Push `main`**

Run: `git push origin main`

Expected: remote `main` advances to the local workflow commit.

- [ ] **Step 4: Dispatch and monitor the workflow**

```bash
gh workflow run release-extension.yml --ref main
gh run watch "$(gh run list --workflow release-extension.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: GitHub Actions concludes `success`.

- [ ] **Step 5: Download and verify published assets**

Download the release into a scoped temporary directory, verify the sidecar with `shasum -a 256 -c`, list the ZIP, and confirm its `manifest.json` version is `0.2.14`.

```bash
release_audit_dir="$(mktemp -d)"
gh release download v0.2.14 --dir "$release_audit_dir"
(cd "$release_audit_dir" && shasum -a 256 -c veo3-kit-extension-v0.2.14.zip.sha256)
unzip -p "$release_audit_dir/veo3-kit-extension-v0.2.14.zip" manifest.json | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s); if(m.version!=="0.2.14") process.exit(1); console.log(m.version);});'
```

Expected: checksum reports `OK` and manifest version prints `0.2.14`.

- [ ] **Step 6: Record final evidence**

Capture the Actions run URL, release URL, tag, commit SHA, asset names, and SHA-256 in the final response. Do not print credentials or provider/session data.
