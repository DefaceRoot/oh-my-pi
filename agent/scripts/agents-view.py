"""CLI entrypoint for Agents View TUI dashboard."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from pathlib import Path

# Ensure the script directory is on sys.path so `agents_view` package resolves
sys.path.insert(0, str(Path(__file__).parent))

from agents_view.app import AgentsViewApp


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Agents View — coding harness session dashboard"
    )
    parser.add_argument(
        "--scope-root",
        default=os.getcwd(),
        help="Only show sessions under this directory (default: cwd)",
    )
    parser.add_argument(
        "--log-level",
        default="WARNING",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(Path.home() / ".omp" / "agents-view.log")],
    )

    app = AgentsViewApp(scope_root=args.scope_root)
    try:
        app.run()
    except KeyboardInterrupt:
        prepare_shutdown = getattr(app, "prepare_shutdown", None)
        if callable(prepare_shutdown):
            try:
                prepare_shutdown()
            except Exception:
                pass
        try:
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        except Exception:
            pass
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
