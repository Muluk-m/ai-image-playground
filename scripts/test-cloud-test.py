#!/usr/bin/env python3
"""Exercise the Cloud entrypoint across independent processes and restored state."""

import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ENTRY = Path(__file__).with_name("cloud-test.py")


class CloudTestContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cloud-test-contract-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "scripts").mkdir()
        shutil.copy(ENTRY, self.root / "scripts/cloud-test.py")
        (self.root / "package.json").write_text(json.dumps({"packageManager": "pnpm@10.33.3"}))
        (self.root / "pnpm-workspace.yaml").write_text("packages: ['apps/*']\n")
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for tool, version in (("node", "v24.19.0"), ("pnpm", "10.33.3"), ("bun", "1.4.3")):
            path = self.tools / tool
            path.write_text(f"#!{sys.executable}\n" + '''
import os, pathlib, sys
root = pathlib.Path.cwd()
if sys.argv[1:] == ['--version']:
    print(VERSION)
    sys.exit(0)
assert 'CLOUD_TEST_SECRET_SENTINEL' not in os.environ
assert not (pathlib.Path.home() / '.npmrc').exists()
assert '--frozen-lockfile' in sys.argv
with (root / 'installs.log').open('a') as log:
    log.write('install\\n')
if (root / 'fail-install').exists():
    sys.exit(42)
dest = root / 'node_modules/.pnpm/lock.yaml'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes((root / 'pnpm-lock.yaml').read_bytes())
'''.replace("VERSION", repr(version)))
            path.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{self.tools}:{os.environ['PATH']}",
                    "GITHUB_ACTIONS": "true", "CLOUD_TEST_SECRET_SENTINEL": "must-not-inherit"}
        self.git("init", "-q")
        self.git("-c", "user.name=Cloud Test", "-c", "user.email=cloud-test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True).strip()

    def invoke(self, *args, ok=True):
        result = subprocess.run([sys.executable, "scripts/cloud-test.py", *args],
                                cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def installs(self):
        return (self.root / "installs.log").read_text().splitlines()

    def test_restore_then_reuse_and_realign_changed_lock(self):
        self.invoke("check", ok=False)
        self.invoke("prepare")
        self.invoke("check")
        self.invoke("prepare")
        self.assertEqual(len(self.installs()), 1)
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n# updated revision\n")
        self.assertIn("dependencies:", self.invoke("check", ok=False))
        self.invoke("prepare")
        self.assertEqual(len(self.installs()), 2)
        (self.root / "node_modules/.pnpm/lock.yaml").unlink()
        self.invoke("prepare")
        self.assertEqual(len(self.installs()), 3)

    def test_manifest_change_invalidates_cache(self):
        self.invoke("prepare")
        app = self.root / "apps/website"
        app.mkdir(parents=True)
        (app / "package.json").write_text('{"name":"website"}')
        self.invoke("check", ok=False)
        self.invoke("prepare")
        self.assertEqual(len(self.installs()), 2)

    def test_failed_install_cannot_be_reported_ready(self):
        (self.root / "fail-install").touch()
        self.assertIn("dependencies: command exited 42", self.invoke("prepare", ok=False))
        self.invoke("check", ok=False)
        self.assertFalse((self.root / "node_modules/.cache/cloud-test.json").exists())

    def test_wrong_revision_stops_before_install(self):
        self.assertIn("revision:", self.invoke("prepare", "--sha", "0" * 40, ok=False))
        self.assertFalse((self.root / "installs.log").exists())

    def test_concurrent_checkout_use_fails_without_mutation(self):
        local = self.root / ".local"
        local.mkdir()
        with (local / "cloud-test.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertIn("another cloud-test command", self.invoke("prepare", ok=False))
        self.assertFalse((self.root / "installs.log").exists())

    def test_submit_rejects_uncommitted_work(self):
        self.assertIn("commit changes", self.invoke("submit", ok=False))
        self.assertFalse((self.root / "installs.log").exists())


class BunEnvironmentContract(unittest.TestCase):
    @unittest.skipUnless(shutil.which("bun"), "Bun is required for the real child-process check")
    def test_isolated_runner_does_not_load_dotenv_in_test_children(self):
        runner = ENTRY.with_name("run-bun-tests-isolated.ts")
        bun = subprocess.check_output(["bun", "-p", "process.execPath"], cwd=ENTRY.parent.parent, text=True).strip()
        with tempfile.TemporaryDirectory(prefix="cloud-test-dotenv-") as directory:
            root = Path(directory)
            (root / ".env").write_text("CLOUD_TEST_DOTENV_LEAK=must-not-load\n")
            (root / "environment.test.ts").write_text(
                "import {test, expect} from 'bun:test';\n"
                "test('dotenv is disabled', () => expect(process.env.CLOUD_TEST_DOTENV_LEAK).toBeUndefined());\n"
            )
            result = subprocess.run([bun, "--no-env-file", "run", str(runner), str(root)],
                                    cwd=root, env={"PATH": os.environ["PATH"], "HOME": directory},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
