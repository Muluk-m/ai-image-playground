#!/usr/bin/env python3
"""Publish only the website/tutorial manifest to the existing ai-images bucket."""

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "apps/web/public"
CONTENT = ROOT / "apps/web/src/features/guide/content"
MANIFEST = CONTENT / "site-assets.json"
BASE = "https://store.kaleidonova.com/muvloom/site/"
ACCOUNT = "4afe694ac3841dc3e433b6369c754346"
BUCKET = "ai-images"
FOLDERS = ("brand", "guide-assets", "og", "website-assets")
NEW_CLIPS = {
    "workbuddy-tutorial.mp4": "4e23ed5c4f95c5a32ae340620170b65aa0440424655e6210abc942a640d0c10a",
    "workbuddy-tutorial.webm": "0450c6e40878e498106bb93e2c7ad26cec427143e0f5da6cddc6ad6efb6acedb",
}


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest()


def image_manifest():
    assets = {}
    for folder in FOLDERS:
        for path in sorted((PUBLIC / folder).rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".svg", ".webp", ".png", ".jpg", ".jpeg", ".ico"}:
                raise ValueError(f"Unexpected public media file: {path.relative_to(ROOT)}")
            rel = path.relative_to(PUBLIC)
            assets[f"/{rel.as_posix()}"] = rel.with_name(
                f"{path.stem}-{digest(path)[:12]}{path.suffix}"
            ).as_posix()
    return assets


def download(url, destination):
    # The migration sources are public URLs from the checked-in legacy inventory.
    with urlopen(url, timeout=60) as response, destination.open("wb") as output:
        if response.status != 200:
            raise ValueError(f"Download HTTP {response.status}: {url}")
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def aws_environment(env_file):
    values = {}
    for line in env_file.read_text().splitlines():
        line = line.strip().removeprefix("export ")
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip().startswith("S3_"):
            parts = shlex.split(value, comments=True)
            values[key.strip()] = parts[0] if parts else ""
    endpoint = f"https://{ACCOUNT}.r2.cloudflarestorage.com"
    if values.get("S3_ENDPOINT", "").rstrip("/") != endpoint or values.get("S3_BUCKET") != BUCKET:
        raise ValueError("Credential file must target the specified Cloudflare account and ai-images")
    if not values.get("S3_ACCESS_KEY_ID") or not values.get("S3_SECRET_ACCESS_KEY"):
        raise ValueError("S3 upload credentials are missing")
    env = dict(os.environ)
    env.update({
        "AWS_ACCESS_KEY_ID": values["S3_ACCESS_KEY_ID"],
        "AWS_SECRET_ACCESS_KEY": values["S3_SECRET_ACCESS_KEY"],
        "AWS_DEFAULT_REGION": "auto",
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_MAX_ATTEMPTS": "2",
        "AWS_PAGER": "",
    })
    env.pop("AWS_SESSION_TOKEN", None)
    return env, endpoint


def upload(path, key, sha, env, endpoint):
    mime = mimetypes.guess_type(path.name)[0]
    if not mime:
        raise ValueError(f"Unknown content type: {path.name}")
    result = subprocess.run([
        "aws", "--endpoint-url", endpoint, "--cli-connect-timeout", "10",
        "--cli-read-timeout", "60", "s3api", "put-object", "--bucket", BUCKET,
        "--key", f"muvloom/site/{key}", "--body", str(path),
        "--content-type", mime, "--cache-control", "public, max-age=31536000, immutable",
        "--metadata", f"sha256={sha}", "--if-none-match", "*",
    ], env=env, capture_output=True, text=True)
    # Never overwrite an existing object. A pre-existing key is accepted only after
    # its public bytes have been verified below, just like a newly uploaded object.
    if result.returncode and "PreconditionFailed" not in result.stderr:
        raise RuntimeError(f"R2 upload failed for {key}; check connectivity and object-write access")


def verify_public(url, expected_sha, expected_size, temp):
    download(url, temp)
    if temp.stat().st_size != expected_size or digest(temp) != expected_sha:
        raise ValueError(f"Public object content does not match source: {url}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--refresh-images", action="store_true")
    mode.add_argument("--upload", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--video-dir", type=Path, default=ROOT / "scripts/docs-videos/out")
    args = parser.parse_args()
    report = []
    inventory_sha = None
    report_path = args.video_dir / "site-media-verification.json"

    def save_report(complete):
        temporary = report_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps({
            "complete": complete, "bucket": BUCKET, "base": BASE,
            "inventory_sha256": inventory_sha, "objects": report,
        }, indent=2) + "\n")
        temporary.replace(report_path)

    # Invalidate an old success before any manifest, film, or credential validation.
    if args.upload or args.verify_only:
        args.video_dir.mkdir(parents=True, exist_ok=True)
        save_report(False)
    images = image_manifest()
    if args.refresh_images:
        MANIFEST.write_text(json.dumps(images, ensure_ascii=False, indent=2) + "\n")
        print(f"Refreshed {len(images)} image mappings")
        return
    if json.loads(MANIFEST.read_text()) != images:
        raise ValueError("Images changed: run --refresh-images and publish before deploying callers")
    clips = dict(re.findall(
        r"'([^']+\.(?:mp4|webm))':\s*'(https://store\.kaleidonova\.com/muvloom/site/clips/[^']+)'",
        (CONTENT / "media.ts").read_text(),
    ))
    legacy = json.loads((ROOT / "scripts/docs-videos/legacy-clips.json").read_text())
    if set(clips) != set(legacy) | set(NEW_CLIPS):
        raise ValueError("Clip inventory does not match the website media map")
    inventory_sha = hashlib.sha256(json.dumps({
        "images": images, "clips": clips, "approved_films": NEW_CLIPS,
    }, sort_keys=True).encode()).hexdigest()
    for name, sha in NEW_CLIPS.items():
        path = args.video_dir / name
        if not path.is_file() or digest(path) != sha:
            raise ValueError(f"Missing or changed approved final film: {name}")
    print(f"Inventory: {len(images)} images, {len(clips)} videos; target {BUCKET} at {BASE}")
    if not args.upload and not args.verify_only:
        print("Plan checked. No remote writes; use --upload to copy and verify all public bytes.")
        return
    if args.upload and not args.env_file:
        parser.error("--upload requires --env-file (credentials are never written to the report)")
    credentials = aws_environment(args.env_file) if args.upload else None
    save_report(False)
    with tempfile.TemporaryDirectory(prefix="muvloom-site-media-") as work:
        temp = Path(work)
        objects = [(PUBLIC / source.lstrip("/"), key) for source, key in images.items()]
        # Fetch old videos only from the exact legacy URLs, never enumerate user assets.
        for name, url in clips.items():
            if name in NEW_CLIPS:
                source = args.video_dir / name
            else:
                source = temp / name
                download(legacy[name], source)
            objects.append((source, url.removeprefix(BASE)))
        for path, key in objects:
            sha, size = digest(path), path.stat().st_size
            if credentials:
                upload(path, key, sha, *credentials)
            verify_public(BASE + key, sha, size, temp / "public-check")
            report.append({"url": BASE + key, "sha256": sha, "bytes": size})
            save_report(False)
            print(f"Verified {len(report)}/{len(objects)}: {key}", flush=True)
    save_report(True)
    print(f"All {len(report)} objects verified. Report: {report_path}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        sys.exit(1)
