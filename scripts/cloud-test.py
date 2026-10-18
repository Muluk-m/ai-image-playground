#!/usr/bin/env python3
"""Prepare and test the checked-out public workspace in Cloud or GitHub Actions."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "deploy/compose.cloud-test.yaml"
STATE = ROOT / "node_modules/.cache/cloud-test.json"
TARGETS = ("check", "web", "bff", "db")


class Failure(Exception):
    pass


def run(command, *, stage, env=None, cwd=ROOT, capture=False):
    try:
        result = subprocess.run(command, cwd=cwd, env=env, text=True,
                                stdout=subprocess.PIPE if capture else None, check=False)
    except OSError as error:
        raise Failure(f"{stage}: {command[0]} unavailable ({error.strerror})") from error
    if result.returncode:
        raise Failure(f"{stage}: command exited {result.returncode}")
    return result.stdout.strip() if capture else ""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def toolchain():
    versions = {tool: run([tool, "--version"], stage="tools", capture=True)
                for tool in ("node", "pnpm", "bun")}
    expected = json.loads((ROOT / "package.json").read_text())["packageManager"].split("@", 1)[1]
    if not versions["node"].startswith("v24.") or versions["pnpm"] != expected:
        raise Failure(f"tools: requires Node 24 and pnpm {expected}; found {versions}")
    print(f"[tools] {json.dumps(versions)}", flush=True)
    return versions


def dependency_state(versions):
    paths = [ROOT / "package.json", ROOT / "pnpm-lock.yaml", ROOT / "pnpm-workspace.yaml"]
    for pattern in ("apps/*/package.json", "packages/*/package.json", "private/apps/*/package.json"):
        paths.extend(sorted(ROOT.glob(pattern)))
    return {"tools": versions, "inputs": {str(p.relative_to(ROOT)): digest(p) for p in paths},
            "installed": digest(ROOT / "node_modules/.pnpm/lock.yaml")
            if (ROOT / "node_modules/.pnpm/lock.yaml").is_file() else None}


def dependencies_ready(versions):
    if not STATE.is_file():
        return False
    try:
        saved = json.loads(STATE.read_text())
    except (ValueError, OSError):
        return False
    current = dependency_state(versions)
    if saved != current or current["installed"] is None:
        return False
    # A restored lock record alone does not prove that workspace dependency links survived.
    for relative in current["inputs"]:
        if not relative.endswith("package.json"):
            continue
        manifest_path = ROOT / relative
        manifest = json.loads(manifest_path.read_text())
        for kind in ("dependencies", "devDependencies"):
            for name in manifest.get(kind, {}):
                if not (manifest_path.parent / "node_modules" / name).exists():
                    return False
    return True


def isolated_environment(scratch, *, network=False):
    for name in ("home", "tmp", "cwd", "env"):
        (scratch / name).mkdir(exist_ok=True, mode=0o700)
    env = {"PATH": os.environ["PATH"], "HOME": str(scratch / "home"),
           "TMPDIR": str(scratch / "tmp"), "CI": "true", "NODE_ENV": "test",
           "NODE_OPTIONS": "--no-experimental-webstorage", "BUN_TEST_JOBS": "1",
           "VITEST_MAX_WORKERS": "1", "npm_config_cache": str(ROOT / ".local/npm-cache")}
    if network:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
                    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"):
            if key in os.environ:
                env[key] = os.environ[key]
        # npm user/global configuration is deliberately empty, while platform TLS/proxy survive.
        for key, name in (("npm_config_userconfig", "npm-user.conf"),
                          ("npm_config_globalconfig", "npm-global.conf")):
            path = scratch / name
            path.touch(mode=0o600)
            env[key] = str(path)
    return env


def prepare(versions, scratch):
    if dependencies_ready(versions):
        print("[dependencies] current lockfile and installed dependencies verified", flush=True)
        return
    print("[dependencies] stale or unverified cache; running frozen install", flush=True)
    before = digest(ROOT / "pnpm-lock.yaml")
    run(["pnpm", "install", "--frozen-lockfile", "--store-dir", str(ROOT / ".local/pnpm-store")], stage="dependencies",
        env=isolated_environment(scratch, network=True))
    if before != digest(ROOT / "pnpm-lock.yaml"):
        raise Failure("dependencies: install changed pnpm-lock.yaml")
    state = dependency_state(versions)
    if state["installed"] is None:
        raise Failure("dependencies: install did not produce node_modules/.pnpm/lock.yaml")
    STATE.parent.mkdir(parents=True, exist_ok=True)
    pending = STATE.with_suffix(".tmp")
    pending.write_text(json.dumps(state, sort_keys=True) + "\n")
    pending.replace(STATE)
    print("[dependencies] frozen install verified and recorded", flush=True)


def compose(*args, capture=False):
    env = os.environ.copy()
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        env.pop(key, None)
    project = "aip-cloud-test-" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    return run(["docker", "--host=unix:///var/run/docker.sock", "compose", "--project-name", project,
                "--file", str(COMPOSE), *args], stage="database", env=env, capture=capture)


def database_url():
    supplied = os.environ.get("CLOUD_TEST_DATABASE_URL")
    if supplied:
        url = urlparse(supplied)
        if url.scheme not in ("postgres", "postgresql") or url.hostname != "127.0.0.1" or url.path != "/aip_cloud_test":
            raise Failure("database: CLOUD_TEST_DATABASE_URL must target 127.0.0.1/aip_cloud_test")
        return supplied
    compose("up", "--detach", "--pull", "never", "--wait", "--wait-timeout", "60", "postgres")
    address = compose("port", "postgres", "5432", capture=True)
    if not address.startswith("127.0.0.1:") or not address.split(":")[-1].isdigit():
        raise Failure("database: expected a loopback-only PostgreSQL port")
    compose("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "aip_cloud_test",
            "-v", "ON_ERROR_STOP=1", "-Atc", "SELECT 1")
    print("[database] isolated PostgreSQL ready", flush=True)
    return f"postgres://postgres@{address}/aip_cloud_test"


def test(target, file_filter, scratch):
    env = isolated_environment(scratch)
    if target == "web":
        run(["pnpm", "--dir", "apps/web", "gen:hero-seed"], stage="tests", env=env)
        script = ROOT / "scripts/cloud-vitest.mjs"
        run(["node", str(script), *([file_filter] if file_filter else [])], stage="tests", env=env)
    else:
        env["TEST_DATABASE_URL"] = database_url()
        root = ROOT / ("apps/bff/src" if target == "bff" else "packages/db/src")
        # Resolve the runtime before changing cwd: project-scoped PATH shims intentionally
        # refuse to select this project's Bun from the empty test scratch directory.
        bun = run(["bun", "-p", "process.execPath"], stage="tools", capture=True)
        command = [bun, "--no-env-file", "run", str(ROOT / "scripts/run-bun-tests-isolated.ts")]
        if file_filter:
            command.extend(["--filter", file_filter])
        run([*command, str(root)], stage="tests", env=env, cwd=scratch / "cwd")
    print(f"[tests] {target} passed", flush=True)


def submit(args):
    # Dispatch a committed, pushed revision, never an agent's unsynchronised working directory.
    if run(["git", "status", "--porcelain"], stage="dispatch", capture=True):
        raise Failure("dispatch: commit changes before submitting Cloud tests")
    sha = run(["git", "rev-parse", "HEAD"], stage="dispatch", capture=True)
    branch = run(["git", "symbolic-ref", "--short", "HEAD"], stage="dispatch", capture=True)
    remote = run(["git", "ls-remote", "origin", f"refs/heads/{branch}"], stage="dispatch", capture=True)
    if not remote or remote.split()[0] != sha:
        raise Failure("dispatch: push this exact branch HEAD to origin first")
    run(["gh", "workflow", "run", "cloud-tests.yml", "--ref", branch,
         "-f", f"expected_sha={sha}", "-f", f"target={args.target}",
         "-f", f"filter={args.filter or ''}"], stage="dispatch")
    print(f"[dispatch] submitted {args.target} for {sha}; inspect gh run list --workflow cloud-tests.yml", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=(*TARGETS, "prepare", "down", "submit"))
    parser.add_argument("--sha", help="Require this full checked-out commit before doing any work")
    parser.add_argument("--filter", help="Test file path/substring (not a shell command)")
    parser.add_argument("--target", choices=TARGETS, default="check", help="Target for submit")
    args = parser.parse_args()
    if args.filter and (args.filter.startswith("-") or args.command not in ("web", "bff", "db", "submit")
                        or (args.command == "submit" and args.target == "check")):
        parser.error("--filter requires a test target and must not start with '-'")
    actual = run(["git", "rev-parse", "HEAD"], stage="revision", capture=True)
    if args.sha and args.sha != actual:
        raise Failure(f"revision: expected {args.sha}, checked out {actual}; no work performed")
    print(f"[revision] {actual}", flush=True)
    if args.command == "submit":
        submit(args)
        return
    if not Path("/etc/codex/network-policy.json").is_file() and os.environ.get("GITHUB_ACTIONS") != "true":
        raise Failure("environment: run heavy checks in Codex Cloud or GitHub Actions; use submit locally")
    lock_path = ROOT / ".local/cloud-test.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("environment: another cloud-test command owns this checkout; retry after it finishes") from error
        if args.command == "down":
            compose("down")
            return
        versions = toolchain()
        if args.command == "check":
            if not dependencies_ready(versions):
                raise Failure("dependencies: stale/unverified; run python3 scripts/cloud-test.py prepare")
            print("[dependencies] ready; no app listener or database is required for this check", flush=True)
            return
        with tempfile.TemporaryDirectory(prefix="aip-cloud-test-") as directory:
            scratch = Path(directory)
            prepare(versions, scratch)
            if args.command != "prepare":
                test(args.command, args.filter, scratch)


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print(f"ERROR [{error}]", file=sys.stderr)
        sys.exit(1)
