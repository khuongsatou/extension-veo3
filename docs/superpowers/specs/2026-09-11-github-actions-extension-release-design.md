# GitHub Actions Extension Release Design

## Goal

Add a manually triggered GitHub Actions workflow that packages the current Veo3 Kit Chrome extension and publishes a versioned GitHub Release.

## Release Contract

- The workflow is started manually with `workflow_dispatch`.
- The release version is read from `manifest.json`; operators do not enter a second version value.
- The tag is `v<manifest version>`, for example `v0.2.14`.
- The release asset is `veo3-kit-extension-v<manifest version>.zip`.
- A matching SHA-256 sidecar is published with the ZIP.
- Re-running a version whose tag or release already exists fails without overwriting the existing release.

## Package Contents

The ZIP contains the loadable Chrome extension at its root so users can unzip it and select that directory with Chrome's **Load unpacked** action. Runtime files include `manifest.json`, JavaScript, HTML, CSS, `assets/`, `side_panel_styles/`, `split-source/`, and `_metadata/`.

Repository-only content is excluded: `.git/`, `.github/`, and `docs/`.

## Workflow Gates

Before publishing, the workflow will:

1. Validate `manifest.json` and derive the version and artifact names.
2. Run `node --check` on every extension JavaScript file.
3. Validate `manifest.json` and `rules.json` as JSON.
4. Build the ZIP from the approved runtime paths.
5. Extract the ZIP into a temporary directory and verify the manifest version plus every manifest-referenced local runtime file.
6. Generate and verify the SHA-256 checksum.
7. Upload the ZIP and checksum as GitHub Actions artifacts.
8. Create the Git tag and GitHub Release only after all earlier gates pass.

## Permissions And Failure Behavior

The job uses the repository-provided `GITHUB_TOKEN` with only `contents: write`. No external secrets, cookies, profile data, or provider credentials are required. Any validation or packaging failure stops the job before a tag or release is created.

## Verification

The workflow definition will be checked locally with a focused static contract test before push. After push, the manual action will be dispatched and monitored to completion. The final release is accepted only when the action succeeds and the downloaded ZIP/checksum match the manifest version and checksum.
