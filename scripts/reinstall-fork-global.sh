#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

PACKAGES=(utils natives ai agent tui stats coding-agent)
GLOBAL_PACKAGES=(
  @oh-my-pi/pi-coding-agent
  @oh-my-pi/pi-utils
  @oh-my-pi/pi-natives
  @oh-my-pi/pi-ai
  @oh-my-pi/pi-agent-core
  @oh-my-pi/pi-tui
  @oh-my-pi/omp-stats
)

resolve_global_node_modules() {
  local bun_bin_dir bun_home
  bun_bin_dir=$(bun pm bin -g)
  bun_home=$(cd "$bun_bin_dir/.." && pwd -P)
  printf '%s\n' "$bun_home/install/global/node_modules"
}

resolve_global_install_root() {
  local global_node_modules
  global_node_modules=$(resolve_global_node_modules)
  printf '%s\n' "$(cd "$global_node_modules/.." && pwd -P)"
}

TARBALL_DIR="$(resolve_global_install_root)/fork-tarballs"

prepare_tarball_cache() {
  mkdir -p "$TARBALL_DIR"
  rm -f "$TARBALL_DIR"/oh-my-pi-pi-*.tgz "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz
}

pack_workspace() {
  local pkg="$1"
  (
    cd "$ROOT_DIR/packages/$pkg"
    bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
  )
}

find_tarball() {
  local pattern="$1"
  local matches=()
  shopt -s nullglob
  matches=( $pattern )
  shopt -u nullglob

  if [[ ${#matches[@]} -ne 1 ]]; then
    echo "Expected exactly one tarball for pattern: $pattern" >&2
    exit 1
  fi

  printf '%s\n' "${matches[0]}"
}

link_workspace_dependencies() {
  local global_node_modules package_name dependency_name package_dir dependency_dir nested_scope nested_dir
  global_node_modules=$(resolve_global_node_modules)

  while IFS=$'\t' read -r package_name dependency_name; do
    package_dir="$global_node_modules/$package_name"
    dependency_dir="$global_node_modules/$dependency_name"
    nested_scope="$package_dir/node_modules/$(dirname "$dependency_name")"
    nested_dir="$package_dir/node_modules/$dependency_name"

    if [[ ! -d "$package_dir" ]]; then
      echo "Expected installed package at $package_dir" >&2
      exit 1
    fi

    if [[ ! -d "$dependency_dir" ]]; then
      echo "Expected installed dependency at $dependency_dir" >&2
      exit 1
    fi

    mkdir -p "$nested_scope"
    rm -rf "$nested_dir"
    ln -s "$dependency_dir" "$nested_dir"
  done < <(
    cd "$ROOT_DIR"
    bun -e '
const packages = ["utils", "natives", "ai", "agent", "tui", "stats", "coding-agent"];
for (const pkg of packages) {
  const packageJson = await Bun.file(`packages/${pkg}/package.json`).json();
  const dependencies = Object.keys(packageJson.dependencies ?? {}).filter(dep => dep.startsWith("@oh-my-pi/") && dep !== packageJson.name);
  for (const dependency of dependencies) {
    console.log(`${packageJson.name}\t${dependency}`);
  }
}
'
  )
}

verify_global_install_state() {
  local global_manifest resolved_omp
  global_manifest="$(resolve_global_install_root)/package.json"
  if [[ ! -f "$global_manifest" ]]; then
    echo "Expected global manifest at $global_manifest" >&2
    exit 1
  fi

  if ! grep -q 'fork-tarballs' "$global_manifest"; then
    echo "Expected global manifest to reference persistent fork tarballs" >&2
    exit 1
  fi

  if grep -Eq '/tmp/tmp\.[^"[:space:]]+/oh-my-pi-.*\.tgz' "$global_manifest"; then
    echo "Global manifest still references temporary tarballs" >&2
    exit 1
  fi

  resolved_omp=$(command -v omp || true)
  if [[ -n "$resolved_omp" ]]; then
    echo "Verified installed omp path: $resolved_omp"
  fi
}

echo "Preparing persistent tarball cache at $TARBALL_DIR..."
prepare_tarball_cache

echo "Packing local workspace packages for global install..."
for pkg in "${PACKAGES[@]}"; do
  pack_workspace "$pkg"
done

utils_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-utils-*.tgz)
natives_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-*.tgz)
ai_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-ai-*.tgz)
agent_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-agent-core-*.tgz)
tui_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-tui-*.tgz)
stats_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz)
coding_agent_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-coding-agent-*.tgz)

echo "Removing previous global fork packages..."
bun remove -g "${GLOBAL_PACKAGES[@]}" >/dev/null || true

echo "Installing packed fork tarballs globally..."
bun add -g \
  "$utils_tgz" \
  "$natives_tgz" \
  "$ai_tgz" \
  "$agent_tgz" \
  "$tui_tgz" \
  "$stats_tgz" \
  "$coding_agent_tgz"

echo "Linking workspace package dependencies inside the global install..."
link_workspace_dependencies

bash "$SCRIPT_DIR/install.sh" --verify-path-precedence
verify_global_install_state

echo "Fork global reinstall complete"
