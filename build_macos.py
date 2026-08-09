#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat Tauri macOS build script

Usage:
    python3 build_macos.py -o <output directory>
    python3 build_macos.py                 # defaults to ./dist
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import time
from pathlib import Path


def fmt_size(num):
    """Format a byte count into a human readable size"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024:
            return f"{num:.2f} {unit}"
        num /= 1024
    return f"{num:.2f} PB"


def main():
    script_dir = Path(__file__).resolve().parent

    if platform.system() != "Darwin":
        print(f"Warning: current system is {platform.system()}, this script is for macOS only.")

    # Parse arguments
    parser = argparse.ArgumentParser(description="KnockChat Tauri macOS build script")
    parser.add_argument(
        "-o", "--output-dir",
        default=str(script_dir / "dist"),
        help="Output directory (default: ./dist)",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir)

    # Read product name
    config_path = script_dir / "src-tauri" / "tauri.conf.json"
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    product_name = config.get("productName", "KnockChat")

    print("=" * 30)
    print("  KnockChat Tauri Build Script")
    print("=" * 30)
    print(f"Product name: {product_name}")
    print(f"Output directory: {output_dir}")
    print("=" * 30)

    # Make sure the output directory exists
    if not output_dir.exists():
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"Created output directory: {output_dir}")

    # Timestamped build artifact directory
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    build_dir = output_dir / timestamp

    print("\nStarting build...")

    # Set TAURI_OUTPUT_DIR and run the build
    env = os.environ.copy()
    env["TAURI_OUTPUT_DIR"] = str(output_dir)

    try:
        result = subprocess.run(
            ["npm", "run", "tauri", "build"],
            cwd=str(script_dir),
            env=env,
        )
        if result.returncode != 0:
            raise SystemExit(f"Tauri build failed, exit code: {result.returncode}")
        print("\nBuild complete!")
    finally:
        env.pop("TAURI_OUTPUT_DIR", None)

    # Collect build artifacts into the timestamped directory
    build_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = script_dir / "src-tauri" / "target" / "release" / "bundle"

    if bundle_dir.exists():
        # .app application bundle (macOS directory-style app)
        macos_dir = bundle_dir / "macos"
        if macos_dir.exists():
            for app in macos_dir.glob("*.app"):
                shutil.copytree(app, build_dir / app.name)
                print(f"Copied app bundle: {app.name}")

        # DMG disk image
        dmg_dir = bundle_dir / "dmg"
        if dmg_dir.exists():
            for dmg in dmg_dir.glob("*.dmg"):
                shutil.copy2(dmg, build_dir / dmg.name)
                print(f"Copied disk image: {dmg.name}")

        # Executable in the release directory
        release_dir = script_dir / "src-tauri" / "target" / "release"
        binary = release_dir / product_name
        if binary.exists() and binary.is_file():
            shutil.copy2(binary, build_dir / binary.name)
            print(f"Copied executable: {binary.name}")

        print(f"Artifacts copied to: {build_dir}")
    else:
        # TAURI_OUTPUT_DIR took effect and artifacts were written directly
        print(f"Artifacts output to: {output_dir}")

    # Show the artifact list
    print("\nArtifacts:")
    found = False
    if build_dir.exists():
        for item in build_dir.rglob("*"):
            if item.suffix == ".dmg" and item.is_file():
                print(f"  {item} ({fmt_size(item.stat().st_size)})")
                found = True
            elif item.suffix == ".app" and item.is_dir():
                print(f"  {item} (directory)")
                found = True
    if not found:
        # Fallback when TAURI_OUTPUT_DIR wrote artifacts directly
        for item in output_dir.rglob("*"):
            if item.suffix == ".dmg" and item.is_file():
                print(f"  {item} ({fmt_size(item.stat().st_size)})")
            elif item.suffix == ".app" and item.is_dir():
                print(f"  {item} (directory)")

    print("\nDone!")


if __name__ == "__main__":
    main()
