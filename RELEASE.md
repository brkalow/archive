# Releasing openctl

This document describes how to release new versions of the openctl CLI.

## Overview

openctl is distributed through two channels:

1. **GitHub Releases** - Pre-compiled binaries for macOS, Linux, and Windows
2. **npm** - For users who prefer `npx openctl` or global npm installation

## Pre-release Checklist

Before releasing, ensure:

- [ ] All tests pass: `bun test`
- [ ] The CLI builds successfully: `bun run build:cli:test`
- [ ] Changes are documented (update README if needed)
- [ ] You're on the `main` branch with a clean working tree

## Versioning

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (`1.0.0` → `2.0.0`): Breaking changes
- **MINOR** (`1.0.0` → `1.1.0`): New features, backward compatible
- **PATCH** (`1.0.0` → `1.0.1`): Bug fixes, backward compatible

For pre-releases, use suffixes like `1.0.0-beta.1` or `1.0.0-rc.1`.

## Release Process

### 1. Update the Version

Update the version in `package.json`:

```bash
# Edit package.json and change the "version" field
# Example: "version": "0.2.0"
```

### 2. Commit the Version Bump

```bash
git add package.json
git commit -m "Bump version to 0.2.0"
git push origin main
```

### 3. Create and Push a Git Tag

The tag triggers the automated release workflow.

```bash
# Create an annotated tag
git tag -a v0.2.0 -m "Release v0.2.0"

# Push the tag to trigger the release
git push origin v0.2.0
```

### 4. Monitor the Release

1. Go to [GitHub Actions](https://github.com/brkalow/openctl/actions) to watch the release workflow
2. The workflow will:
   - Build binaries for all platforms (macOS, Linux, Windows)
   - Run smoke tests
   - Create compressed archives
   - Publish a GitHub release with auto-generated release notes

### 5. Verify the GitHub Release

After the workflow completes:

1. Check the [Releases page](https://github.com/brkalow/openctl/releases)
2. Verify all platform binaries are attached:
   - `openctl-darwin-arm64.tar.gz`
   - `openctl-darwin-x64.tar.gz`
   - `openctl-linux-x64.tar.gz`
   - `openctl-linux-arm64.tar.gz`
   - `openctl-windows-x64.zip`
3. Test the install script with the new release:
   ```bash
   curl -fsSL https://openctl.dev/setup/install.sh | bash
   openctl --version
   ```

## Publishing to npm

After the GitHub release is complete, publish to npm:

### First-time Setup

```bash
# Login to npm (if not already logged in)
npm login
```

### Publish

```bash
# Publish to npm registry
npm publish

# For pre-releases, use a tag
npm publish --tag beta
```

### Verify npm Release

```bash
# Check the published version
npm view openctl version

# Test installation
npx openctl --version
```

## Quick Release Commands

For a standard release:

```bash
# 1. Ensure tests pass
bun test

# 2. Update version in package.json, then:
git add package.json
git commit -m "Bump version to X.Y.Z"
git push origin main

# 3. Tag and release
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z

# 4. After GitHub release completes, publish to npm
npm publish
```

## Troubleshooting

### Release workflow failed

1. Check the [Actions logs](https://github.com/brkalow/openctl/actions) for error details
2. Common issues:
   - Build failures: Run `bun run build:cli:test` locally to reproduce
   - Smoke test failures: Check if CLI entry point is correct
3. Fix the issue, then delete and recreate the tag:
   ```bash
   git tag -d vX.Y.Z
   git push origin :refs/tags/vX.Y.Z
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

### npm publish failed

- Ensure you're logged in: `npm whoami`
- Check package name availability: `npm view openctl`
- Verify version hasn't been published: `npm view openctl versions`

### Install script not finding new release

The install script fetches from GitHub's releases API. If the new version isn't available:

1. Verify the release is published (not draft)
2. Check the release has the expected asset names
3. GitHub API may have slight delays; wait a few minutes and retry

## Local Testing

To test the release process locally without publishing:

```bash
# Build all platforms
bun run build:cli

# Build with smoke tests
bun run build:cli:test

# Build with archives (simulates full release)
bun run build:cli:release

# Test install script with local build
LOCAL_DIST=./dist ./install.sh
```
