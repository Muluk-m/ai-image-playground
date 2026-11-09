#!/usr/bin/env python3
"""Build the exact same release assets for PR smoke tests and approved releases."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess


TARGETS = (
    ("darwin", "arm64"),
    ("darwin", "amd64"),
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("windows", "amd64"),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        parser.error("version must be an exact stable X.Y.Z version (no cli-v prefix)")
    root = Path(__file__).resolve().parents[1]
    # The version is compiled in from internal/version/VERSION, the single source shared
    # with the bundled Skill's metadata. --version stays required so the release tag is
    # cross-checked against that source here instead of producing a mislabelled release.
    source = (root / "internal" / "version" / "VERSION").read_text(encoding="utf-8").strip()
    if args.version != source:
        parser.error(
            f"--version {args.version} does not match cli-go/internal/version/VERSION ({source}); "
            "bump that file in the release commit"
        )
    output = args.output.resolve()
    # Refuse stale binaries/checksums instead of silently publishing mixed releases.
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("output directory must be empty")
    checksums = []
    for goos, goarch in TARGETS:
        suffix = ".exe" if goos == "windows" else ""
        asset = output / f"muvloom_{goos}_{goarch}{suffix}"
        subprocess.run(
            [
                "go", "build", "-trimpath", "-ldflags", "-s -w",
                "-o", str(asset), "./cmd/muvloom",
            ],
            cwd=root,
            env={**os.environ, "CGO_ENABLED": "0", "GOOS": goos, "GOARCH": goarch},
            check=True,
        )
        checksums.append(f"{hashlib.sha256(asset.read_bytes()).hexdigest()}  {asset.name}\n")
    for name in ("install.sh", "install.ps1"):
        shutil.copyfile(root / "install" / name, output / name)
    (output / "checksums.txt").write_text("".join(checksums), encoding="utf-8")


if __name__ == "__main__":
    main()
