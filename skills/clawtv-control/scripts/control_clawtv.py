#!/usr/bin/env python3
"""Run the ClawTV repo CLI with stable defaults for OpenClaw skills."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_SERVER_ORIGIN = "http://localhost:8787/ClawTV/"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the ClawTV CLI from a known repo checkout."
    )
    parser.add_argument(
        "--repo-root",
        help="Path to the ClawTV repo checkout. Defaults to CLAWTV_REPO_ROOT or the repo that contains this script.",
    )
    parser.add_argument(
        "--server-origin",
        help="ClawTV server origin. Defaults to CLAWTV_SERVER_ORIGIN or http://localhost:8787/ClawTV/.",
    )
    parser.add_argument(
        "command",
        help="ClawTV command such as status, now-playing, play, pause, or stop.",
    )
    parser.add_argument(
        "command_args",
        nargs=argparse.REMAINDER,
        help="Arguments passed through to the ClawTV CLI command.",
    )
    return parser


def resolve_repo_root(explicit_value: str | None) -> Path:
    candidates: list[str] = []

    if explicit_value:
        candidates.append(explicit_value)

    env_value = os.environ.get("CLAWTV_REPO_ROOT")
    if env_value:
        candidates.append(env_value)

    candidates.append(str(Path(__file__).resolve().parents[3]))

    for candidate in candidates:
        repo_root = Path(candidate).expanduser()
        cli_entry = repo_root / "apps" / "cli" / "src" / "index.ts"
        package_json = repo_root / "package.json"
        if repo_root.is_dir() and cli_entry.is_file() and package_json.is_file():
            return repo_root

    formatted = "\n".join(f"- {candidate}" for candidate in candidates)
    raise SystemExit(
        "Could not locate the ClawTV repo checkout.\n"
        "Checked:\n"
        f"{formatted}\n"
        "Set CLAWTV_REPO_ROOT or pass --repo-root."
    )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    pnpm_path = shutil.which("pnpm")
    if not pnpm_path:
        raise SystemExit("pnpm is required but was not found on PATH.")

    repo_root = resolve_repo_root(args.repo_root)
    server_origin = args.server_origin or os.environ.get(
        "CLAWTV_SERVER_ORIGIN", DEFAULT_SERVER_ORIGIN
    )

    command = [
        pnpm_path,
        "--dir",
        str(repo_root),
        "--filter",
        "@clawtv/cli",
        "dev",
        args.command,
        *args.command_args,
    ]

    env = os.environ.copy()
    env["CLAWTV_SERVER_ORIGIN"] = server_origin

    completed = subprocess.run(command, cwd=repo_root, env=env)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
