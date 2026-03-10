# Source this from your .bashrc or .zshrc to make the fork-direct `omp` command available.
# Usage: source /path/to/oh-my-pi/bin/setup-path.sh

_OMP_FORK_BIN="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
case ":$PATH:" in
  *":$_OMP_FORK_BIN:"*) ;;
  *) export PATH="$_OMP_FORK_BIN:$PATH" ;;
esac
unset _OMP_FORK_BIN
