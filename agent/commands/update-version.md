---
name: update-version
description: Update version across all config files (spawns Version subagent)
argument-hint: "[patch|minor|major]"
agent: build
subtask: true
---

<role>
YOU ARE A VERSION UPDATER. Execute the version bump completely and accurately.
</role>

<constraints>
CRITICAL - DO NOT:
- Skip any files that need updating
- Leave version numbers inconsistent across files
- Forget to regenerate package-lock.json
- Skip the CHANGELOG entry
- Use staged file diffs as the changelog source of truth
- Leave version/changelog changes uncommitted
- Leave version/changelog commit unpushed to origin
- **NEVER write generic changelog entries** like "Version bump to X.Y.Z"
- **NEVER let changelog exceed 10 versions** - delete oldest entries as needed

MUST DO:
- Verify the worktree starts clean (no staged/unstaged/untracked changes) before editing version files
- Read current version first
- Calculate new version correctly based on increment type
- Update ALL 4 required files
- Run npm install to regenerate lock file
- Analyze commits from the active worktree branch range (`origin/<base>..HEAD`) and use those commits as the changelog source of truth
- **Write detailed CHANGELOG entry** based on worktree commits and plan scope (if plan file is available in Worktree Active context)
- If `origin/<base>..HEAD` has no functional commits, STOP and report blocked instead of writing a placeholder changelog
- **Maintain 10-version limit** in CHANGELOG (delete oldest if >10)
- **Stage all changed files**, commit them with a release bump message, and push to origin for the active worktree branch
- **Verify final git state before success**: working tree clean and upstream sync is exactly behind 0 / ahead 0
- Report completion with old → new version
</constraints>

<input>
User specified: $ARGUMENTS

Increment type resolution:
- If empty or "patch": Bump patch version (+0.0.1)
- If "minor": Bump minor version (+0.1.0), reset patch to 0
- If "major": Bump major version (+1.0.0), reset minor and patch to 0
</input>

<objective>
Update the Dragonglass application version across all configuration files.

This command updates the version number in all required files to maintain version consistency across the Rust workspace, Tauri configuration, and frontend package.
</objective>

<version_increment_rules>
## Version Increment Logic (Semantic Versioning)

Parse the current version as `MAJOR.MINOR.PATCH` (e.g., `1.0.1`).

| Command | Increment | Example | Description |
|---------|-----------|---------|-------------|
| `/update-version` (no args) | +0.0.1 | 1.0.1 → 1.0.2 | Patch/build version bump |
| `/update-version minor` | +0.1.0 | 1.0.1 → 1.1.0 | Minor version bump, reset patch to 0 |
| `/update-version major` | +1.0.0 | 1.0.1 → 2.0.0 | Major version bump, reset minor and patch to 0 |

**CRITICAL**: When bumping minor version, ALWAYS set patch to 0. When bumping major version, ALWAYS set both minor and patch to 0.
</version_increment_rules>

<files_to_update>
## Files Requiring Version Updates

Update these 4 files with the new version string:

### 1. Cargo.toml (Workspace Root)
**Path:** `./Cargo.toml`
**Line:** 11
**Format:** `version = "X.Y.Z"`
```toml
[workspace.package]
version = "NEW_VERSION"
```

### 2. app/src-tauri/Cargo.toml (Main Application)
**Path:** `./app/src-tauri/Cargo.toml`
**Line:** 4
**Format:** `version = "X.Y.Z"`
```toml
[package]
name = "dragonglass-app"
description = "Dragonglass - Privacy-focused wireless connectivity control for Windows"
version = "NEW_VERSION"
```

### 3. app/package.json (Frontend)
**Path:** `./app/package.json`
**Line:** 3
**Format:** `"version": "X.Y.Z"`
```json
{
  "name": "dragonglass-app",
  "version": "NEW_VERSION",
```

### 4. app/src-tauri/tauri.conf.json (Tauri Config)
**Path:** `./app/src-tauri/tauri.conf.json`
**Line:** 3
**Format:** `"version": "X.Y.Z"`
```json
{
    "productName": "Dragonglass",
    "version": "NEW_VERSION",
```

### 5. enforcer/Cargo.toml (Auto-Inherited)
**Path:** `./enforcer/Cargo.toml`
**NO EDIT NEEDED** - Uses `version.workspace = true` and automatically inherits from workspace root.
</files_to_update>

<lock_file_regeneration>
## Regenerate package-lock.json

After updating `app/package.json`, run npm install to regenerate the lock file:

```bash
cd app && npm install
```

This updates `app/package-lock.json` lines 3 and 9 to match the new version.
</lock_file_regeneration>

<changelog_update>
## Add CHANGELOG.md Entry

**Path:** `./CHANGELOG.md`

### Step 1: Build Worktree Commit Range (SOURCE OF TRUTH)

**This workflow assumes there are no staged changes when `/update-version` starts.**

Determine base branch and analyze the active worktree branch diff range:

```bash
# Resolve base branch
if git show-ref --verify --quiet refs/remotes/origin/master; then
  BASE_BRANCH=master
else
  BASE_BRANCH=main
fi

# Collect commits unique to this worktree branch
git log --reverse --no-merges --format="%H%x09%s" "origin/${BASE_BRANCH}..HEAD"
git log --no-merges --stat "origin/${BASE_BRANCH}..HEAD"
```

If available from Worktree Active context, read the bound plan file (`docs/plans/.../*.md`) and ensure changelog bullets reflect implemented plan scope.

**MUST ANALYZE commits for:**
- Features added (feat:)
- Bugs fixed (fix:)
- Documentation changes (docs:)
- Performance improvements (perf:)
- Refactoring (refactor:)
- Any other user-visible changes

**IGNORE release/version-only commits** such as `chore(release): bump version ...` when summarizing functional changes.

### Step 2: Write Detailed Changelog Entry

Insert a new version entry at the TOP of the changelog (after the header, before the first `## [X.Y.Z]` entry).

**Use this exact section ordering and only include non-empty sections:**

```markdown
## [NEW_VERSION] - YYYY-MM-DD

### Added
- User-facing additions derived from worktree commits

### Changed
- Behavioral/perf/refactor improvements derived from worktree commits

### Fixed
- Bug fixes derived from worktree commits

### Removed
- Removals/deprecations (only if applicable)
```

**Guidelines:**
- Use today's date in `YYYY-MM-DD` format
- Only include categories that have actual changes (don't add empty sections)
- Write clear, user-facing descriptions (not implementation details)
- Each bullet should explain WHAT changed and WHY it matters
- Be concise but informative
- **NEVER write generic entries like "Version bump to X.Y.Z"** - always describe actual changes

### Step 3: Maintain 10-Version Limit

**CRITICAL**: The changelog must contain **ONLY the last 10 versions**.

After adding the new entry:
1. Count the number of `## [X.Y.Z]` version headers in the file
2. If there are MORE than 10 versions, **DELETE the oldest entry** (the one at the bottom)
3. Repeat until only 10 versions remain

**How to identify version entries:**
- Each version starts with `## [X.Y.Z] - YYYY-MM-DD`
- Delete from `## [OLD_VERSION]` through to (but not including) the next `## [` or end of file

**Example deletion:**
If changelog has versions 1.0.0 through 1.0.10 (11 entries) and you're adding 1.0.11:
- Add `## [1.0.11]` at the top
- Delete `## [1.0.0]` section entirely (the oldest)
- Result: versions 1.0.1 through 1.0.11 (10 entries)
</changelog_update>

<execution_steps>
## Execution Order

1. **Validate clean worktree state FIRST** (no staged/unstaged/untracked files before version bump):
   ```bash
   git status --porcelain
   ```

2. **Resolve base branch and analyze all worktree commits** in `origin/<base>..HEAD`:
   ```bash
   if git show-ref --verify --quiet refs/remotes/origin/master; then
     BASE_BRANCH=master
   else
     BASE_BRANCH=main
   fi
   git log --reverse --no-merges --format="%H%x09%s" "origin/${BASE_BRANCH}..HEAD"
   git log --no-merges --stat "origin/${BASE_BRANCH}..HEAD"
   ```
   If no meaningful commits are returned, stop and report blocked.

3. **If Worktree Active context includes a plan file path**, read that plan and keep changelog wording aligned to delivered plan scope.

4. **Read current version** from `./Cargo.toml` line 11 to get the base version

5. **Calculate new version** based on increment type (patch/minor/major)

6. **Edit 4 files** with the new version string (use Edit tool for each)

7. **Run npm install** in `./app` directory to regenerate lock file

8. **Write detailed CHANGELOG entry** based on worktree commit history (and plan scope if available):
   - Add new version entry at TOP of `./CHANGELOG.md`
   - Use section order: Added → Changed → Fixed → Removed
   - Include only non-empty sections
   - Write meaningful descriptions based on actual worktree commits
   - Ignore release/version-only commits
   - **NEVER write generic entries like "Version bump to X.Y.Z"**
   - **Enforce 10-version limit**: If >10 versions exist, delete the oldest

9. **Stage all changed files, commit, and push**:
   ```bash
   CURRENT_BRANCH="$(git branch --show-current)"
   git add ./Cargo.toml ./app/src-tauri/Cargo.toml ./app/package.json ./app/src-tauri/tauri.conf.json ./app/package-lock.json ./CHANGELOG.md
   git commit -m "chore(release): bump version to NEW_VERSION"
   git push --set-upstream origin "$CURRENT_BRANCH"
   ```

10. **Hard verification gate (MUST pass before reporting success)**:
   ```bash
   git status --porcelain
   git rev-list --left-right --count @{upstream}...HEAD
   ```
   - `git status --porcelain` output MUST be empty.
   - `git rev-list --left-right --count @{upstream}...HEAD` MUST be exactly `0 0`.
   - If either check fails, STOP and report blocked/failed (do not claim success).

11. **Report completion** with old version → new version and changelog summary
</execution_steps>

<output>
## Expected Output

After successful execution, report:

```
✅ Version updated: OLD_VERSION → NEW_VERSION

Files updated, committed, and pushed:
- ./Cargo.toml
- ./app/src-tauri/Cargo.toml  
- ./app/package.json
- ./app/src-tauri/tauri.conf.json
- ./app/package-lock.json (regenerated via npm install)
- ./CHANGELOG.md (new entry added)

Note: ./enforcer/Cargo.toml automatically inherits workspace version.

📝 Changelog entry:
## [NEW_VERSION] - YYYY-MM-DD
### Added
- [summary derived from worktree commits]
### Changed  
- [summary derived from worktree commits]
### Fixed
- [summary derived from worktree commits]

📋 Release bump committed and pushed to origin on the active worktree branch.
```
</output>

<examples>
## Usage Examples

**Patch bump (default):**
```
/update-version
# 1.0.1 → 1.0.2
```

**Minor bump:**
```
/update-version minor
# 1.0.1 → 1.1.0
```

**Major bump:**
```
/update-version major
# 1.0.1 → 2.0.0
```
</examples>
