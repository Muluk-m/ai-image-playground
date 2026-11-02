#!/usr/bin/env python3
"""Exercise real installers and freshly built binaries; never contact a release/API.

Usage: python cli-go/install/test-install.py --dist /path/to/dist --version 0.1.0
Requires the upstream skills-ref command on PATH. All installs use temporary homes.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit


EXPECTED_ASSETS = {
    "muvloom_darwin_arm64", "muvloom_darwin_amd64",
    "muvloom_linux_amd64", "muvloom_linux_arm64", "muvloom_windows_amd64.exe",
}


class DistributionHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        parsed = urlsplit(self.path)
        parts = parsed.path.strip("/").split("/")
        mode = parts[0]
        self.server.requests.append((self.path, dict(self.headers)))
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", f"/ok/cli-v{VERSION}/{parts[-1]}")
            self.end_headers()
            return
        if len(parts) == 2 and parts[1] == "releases":
            page = parse_qs(parsed.query).get("page", ["1"])[0]
            releases = [] if mode == "missing" or page != "1" else [
                {"tag_name": "web-v99.0.0", "prerelease": False},
                {"tag_name": f"cli-v{VERSION}", "prerelease": False},
                {"tag_name": "cli-v999.0.0-rc.1", "prerelease": True},
            ]
            body = json.dumps(releases).encode()
        elif len(parts) == 3 and parts[1] == f"cli-v{VERSION}":
            if mode == "not-found":
                self.send_error(404)
                return
            asset = DIST / parts[2]
            if parts[2] not in EXPECTED_ASSETS | {"checksums.txt"}:
                self.send_error(404)
                return
            body = asset.read_bytes()
            if mode == "corrupt" and parts[2] != "checksums.txt":
                body += b"corrupted-download"
            if mode == "no-checksum" and parts[2] == "checksums.txt":
                body = b""
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if parts[-1] == "releases" else "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class InstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), DistributionHandler)
        cls.server.requests = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.windows = platform.system() == "Windows"
        cls.validator = shutil.which("skills-ref")
        if not cls.validator:
            raise RuntimeError("install the pinned upstream skills-ref before running this suite")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="muvloom installer ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "isolated home"
        self.home.mkdir()
        # curl must not inherit authentication headers from a user's curlrc.
        (self.home / ".curlrc").write_text('header = "Authorization: Bearer must-not-leak"\n', encoding="utf-8")
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "go.mod").write_text("module installer-smoke\n", encoding="utf-8")
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.upper().startswith(("MUVLOOM_", "GH_", "GITHUB_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"))
        }
        self.env.update({
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "LOCALAPPDATA": str(self.home / "AppData" / "Local"),
            "APPDATA": str(self.home / "AppData" / "Roaming"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "MUVLOOM_INSTALL_DIR": str(self.home / "installed bin"),
            "MUVLOOM_NO_MODIFY_PATH": "1",
            "NO_PROXY": "127.0.0.1,localhost",
            "MUVLOOM_API_URL": self.origin,
        })
        self.binary = Path(self.env["MUVLOOM_INSTALL_DIR"]) / ("muvloom.exe" if self.windows else "muvloom")
        self.server.requests.clear()

    def install(self, mode="ok", pin=True):
        self.env["MUVLOOM_DISTRIBUTION_URL"] = f"{self.origin}/{mode}"
        if pin:
            self.env["MUVLOOM_VERSION"] = VERSION
        else:
            self.env.pop("MUVLOOM_VERSION", None)
        command = ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(DIST / "install.ps1")] if self.windows else ["sh", str(DIST / "install.sh")]
        return subprocess.run(command, cwd=self.project, env=self.env, text=True, capture_output=True, timeout=60)

    def cli(self, *args, code=0):
        result = subprocess.run([str(self.binary), *args], cwd=self.project, env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        envelope = json.loads(result.stdout)
        self.assertEqual(envelope["schema_version"], 1)
        self.assertEqual(envelope["ok"], code == 0)
        return envelope

    def assert_failed(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(message, (result.stdout + result.stderr).lower())
        self.assertFalse(self.binary.exists())

    def test_exact_release_artifact_names_and_checksums(self):
        self.assertEqual({p.name for p in DIST.iterdir()}, EXPECTED_ASSETS | {"install.sh", "install.ps1", "checksums.txt"})
        entries = {}
        for line in (DIST / "checksums.txt").read_text(encoding="utf-8").splitlines():
            checksum, name = line.split()
            self.assertNotIn(name, entries)
            entries[name] = checksum
        self.assertEqual(set(entries), EXPECTED_ASSETS)
        for name, checksum in entries.items():
            self.assertEqual(checksum, hashlib.sha256((DIST / name).read_bytes()).hexdigest())

    def test_pinned_install_and_real_skill_validation(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.cli("version")["data"]["version"], VERSION)
        for host, directory in (("claude-code", ".claude"), ("codex", ".agents")):
            for scope, root in (("user", self.home), ("project", self.project)):
                data = self.cli("skill", "install", "--host", host, "--scope", scope)["data"]
                expected = root / directory / "skills" / "muvloom"
                self.assertEqual(Path(data["path"]).resolve(), expected.resolve())
                subprocess.run([self.validator, "validate", str(expected)], check=True, timeout=30)
        installed = self.cli("skill", "status")["data"]["installed"]
        self.assertEqual(len(installed), 4)
        self.assertTrue(all(item["intact"] and item["current"] for item in installed))
        self.assertEqual(self.cli("unknown-command", code=2)["error"]["code"], "USAGE")
        for _, headers in self.server.requests:
            self.assertFalse(any(key.lower() in ("authorization", "cookie") for key in headers))

    def test_latest_release_discovery(self):
        result = self.install(pin=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.cli("version")["data"]["version"], VERSION)
        self.assertTrue(any("page=2" in path for path, _ in self.server.requests))

    def test_missing_release_fails(self):
        self.assert_failed(self.install("missing", pin=False), "could not find a muvloom release")

    def test_missing_pinned_release_fails(self):
        result = self.install("not-found")
        self.assert_failed(result, "404" if self.windows else "download failed")

    def test_checksum_failure_preserves_existing_install(self):
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"existing-install")
        result = self.install("corrupt")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("checksum mismatch", (result.stdout + result.stderr).lower())
        self.assertEqual(self.binary.read_bytes(), b"existing-install")

    def test_missing_checksum_fails(self):
        self.assert_failed(self.install("no-checksum"), "no checksum published")

    def test_version_command_failure_propagates(self):
        self.env["MUVLOOM_API_URL"] = "http://untrusted.invalid"
        result = self.install()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_unsupported_platform_fails_before_download(self):
        if self.windows:
            self.env["PROCESSOR_ARCHITECTURE"] = "ARM64"
        else:
            tools = self.root / "tools"
            tools.mkdir()
            uname = tools / "uname"
            uname.write_text("#!/bin/sh\nprintf '%s\\n' Unsupported\n", encoding="utf-8")
            uname.chmod(0o755)
            self.env["PATH"] = str(tools) + os.pathsep + self.env["PATH"]
        self.assert_failed(self.install(), "only windows x64" if self.windows else "unsupported operating system")
        self.assertEqual(self.server.requests, [])

    def test_distribution_override_rejects_non_loopback(self):
        self.env["MUVLOOM_DISTRIBUTION_URL"] = "http://untrusted.invalid"
        command = ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(DIST / "install.ps1")] if self.windows else ["sh", str(DIST / "install.sh")]
        result = subprocess.run(command, cwd=self.project, env=self.env, text=True, capture_output=True, timeout=30)
        self.assert_failed(result, "loopback")
        self.assertEqual(self.server.requests, [])

    def test_loopback_redirect_is_not_followed(self):
        result = self.install("redirect")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.binary.exists())
        self.assertTrue(self.server.requests)
        self.assertTrue(all(path.startswith("/redirect/") for path, _ in self.server.requests))

    @unittest.skipIf(platform.system() == "Windows", "Windows supports only the separately tested x64 platform")
    def test_unsupported_shell_architecture_fails_before_download(self):
        tools = self.root / "tools"
        tools.mkdir()
        uname = tools / "uname"
        uname.write_text(
            '#!/bin/sh\ncase "$1" in -s) echo Linux ;; *) echo riscv64 ;; esac\n',
            encoding="utf-8",
        )
        uname.chmod(0o755)
        self.env["PATH"] = str(tools) + os.pathsep + self.env["PATH"]
        self.assert_failed(self.install(), "unsupported architecture")
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", required=True, type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    DIST = args.dist.resolve()
    VERSION = args.version
    unittest.main(argv=[__file__], verbosity=2)
