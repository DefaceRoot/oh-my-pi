#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
	cat <<'EOF'
Usage: migrate-workflow-from-ssh.sh --source <user@host> [options]

Copies and installs a full OMP workflow setup from a source Linux machine over SSH.
Run this script on the TARGET machine.

Required:
  --source <user@host>      SSH host for the source machine

Options:
  --source-home <path>      Source home directory (default: remote $HOME)
  --target-home <path>      Target home directory (default: local $HOME)
  --exclude-secrets         Do not copy secret-bearing files (~/.omp/agent/settings.json, ~/.omp/mcp.json)
  --dry-run                 Show what would be copied without writing files
  --help                    Show this help

Examples:
  ./migrate-workflow-from-ssh.sh --source colin@source-box
  ./migrate-workflow-from-ssh.sh --source colin@source-box --exclude-secrets
EOF
}

require_cmd() {
	local cmd="$1"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		log_error "Missing required command: $cmd"
		exit 1
	fi
}

check_optional_cmd() {
	local cmd="$1"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		log_warn "Optional command missing: $cmd"
	fi
}

SOURCE_HOST=""
SOURCE_HOME=""
TARGET_HOME="${HOME}"
INCLUDE_SECRETS=true
DRY_RUN=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--source)
			SOURCE_HOST="${2:-}"
			shift 2
			;;
		--source-home)
			SOURCE_HOME="${2:-}"
			shift 2
			;;
		--target-home)
			TARGET_HOME="${2:-}"
			shift 2
			;;
		--exclude-secrets)
			INCLUDE_SECRETS=false
			shift
			;;
		--dry-run)
			DRY_RUN=true
			shift
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			log_error "Unknown argument: $1"
			usage
			exit 1
			;;
	esac
done

if [[ -z "$SOURCE_HOST" ]]; then
	log_error "--source is required"
	usage
	exit 1
fi

if [[ ! -d "$TARGET_HOME" ]]; then
	log_error "Target home does not exist: $TARGET_HOME"
	exit 1
fi

require_cmd ssh
require_cmd rsync
require_cmd perl
check_optional_cmd omp
check_optional_cmd auggie
check_optional_cmd bun
check_optional_cmd tmux
check_optional_cmd ghostty
check_optional_cmd wl-copy
check_optional_cmd git
check_optional_cmd gh

log_info "Checking SSH connectivity to ${SOURCE_HOST}"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SOURCE_HOST" "true"

if [[ -z "$SOURCE_HOME" ]]; then
	SOURCE_HOME="$(ssh "$SOURCE_HOST" 'printf %s "$HOME"')"
	if [[ -z "$SOURCE_HOME" ]]; then
		log_error "Failed to resolve source home directory"
		exit 1
	fi
fi

if [[ "$SOURCE_HOME" != /* ]]; then
	log_error "--source-home must be an absolute path"
	exit 1
fi

if [[ "$TARGET_HOME" != /* ]]; then
	log_error "--target-home must be an absolute path"
	exit 1
fi

log_info "Source host: ${SOURCE_HOST}"
log_info "Source home: ${SOURCE_HOME}"
log_info "Target home: ${TARGET_HOME}"

BASE_PATHS=(
	".omp/agent/AGENTS.md"
	".omp/agent/config.yml"
	".omp/agent/models.yml"
	".omp/agent/mcp.json"
	".omp/agent/commands"
	".omp/agent/rules"
	".omp/agent/extensions"
	".omp/agent/skills"
	".omp/agent/hooks"
	".omp/agent/patches"
	".config/ghostty/config"
	".tmux.conf"
	".tmux.conf.local"
	".tmux"
)

SECRET_PATHS=(
	".omp/agent/settings.json"
	".omp/mcp.json"
)

BACKUP_ROOT="${TARGET_HOME}/.omp-migration-backups/$(date +%Y%m%d-%H%M%S)"
backup_path() {
	local rel="$1"
	local local_path="${TARGET_HOME}/${rel}"
	local backup_path="${BACKUP_ROOT}/${rel}"

	if [[ -e "$local_path" ]]; then
		mkdir -p "$(dirname "$backup_path")"
		cp -a "$local_path" "$backup_path"
	fi
}

copy_rel_path() {
	local rel="$1"
	local src_abs="${SOURCE_HOME}/${rel}"
	local local_parent="$(dirname "${TARGET_HOME}/${rel}")"

	if ! ssh "$SOURCE_HOST" "test -e '$src_abs'"; then
		log_warn "Skipping missing source path: ${src_abs}"
		return 0
	fi

	if [[ "$DRY_RUN" == false ]]; then
		mkdir -p "$local_parent"
		backup_path "$rel"
	fi

	log_info "Syncing ${rel}"
	if [[ "$DRY_RUN" == true ]]; then
		rsync -an "$SOURCE_HOST:$src_abs" "$local_parent/"
	else
		rsync -a "$SOURCE_HOST:$src_abs" "$local_parent/"
	fi
}

rewrite_paths_in_file() {
	local file="$1"
	if [[ ! -f "$file" ]]; then
		return 0
	fi
	if [[ "$SOURCE_HOME" == "$TARGET_HOME" ]]; then
		return 0
	fi

	log_info "Rewriting absolute paths in ${file}"
	if [[ "$DRY_RUN" == true ]]; then
		return 0
	fi

	SRC_HOME="$SOURCE_HOME" DST_HOME="$TARGET_HOME" perl -0pi -e 's/\Q$ENV{SRC_HOME}\E/$ENV{DST_HOME}/g' "$file"
}

for rel in "${BASE_PATHS[@]}"; do
	copy_rel_path "$rel"
done

if [[ "$INCLUDE_SECRETS" == true ]]; then
	log_warn "Including secret-bearing files"
	for rel in "${SECRET_PATHS[@]}"; do
		copy_rel_path "$rel"
	done
else
	log_warn "Secrets excluded. You must set API keys on the target machine manually."
fi

rewrite_paths_in_file "${TARGET_HOME}/.omp/agent/extensions/implementation-engine/index.ts"

log_info "Skipping archived workflow patch bundle migration; reinstall:fork now carries the live runtime changes directly from package source."

if [[ "$DRY_RUN" == false ]]; then
	log_info "Migration complete"
	if [[ -d "$BACKUP_ROOT" ]]; then
		log_info "Backup created at: $BACKUP_ROOT"
	fi
	log_info "Next checks:"
	echo "  omp --version"
	echo "  bun --version"
	echo "  tmux -V"
	echo "  ghostty --version"
else
	log_info "Dry-run complete (no files changed)"
fi
