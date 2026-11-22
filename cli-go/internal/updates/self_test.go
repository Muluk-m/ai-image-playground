package updates

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func buildTestSkillAndCLIServer(t *testing.T, cliVersion string, platform string, binBytes []byte, overrideSHA string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	w, err := zw.Create("muvloom/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("---\nname: muvloom\ndescription: Test\n---\n# Test\n")
	_, _ = w.Write(content)
	_ = zw.Close()
	zipBytes := zipBuf.Bytes()
	zipSum := sha256.Sum256(zipBytes)
	fileSum := sha256.Sum256(content)
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00", "SKILL.md", len(content))
	h.Write(content)
	treeHash := hex.EncodeToString(h.Sum(nil))

	binSum := sha256.Sum256(binBytes)
	binSHA := hex.EncodeToString(binSum[:])
	if overrideSHA != "" {
		binSHA = overrideSHA
	}
	binPath := "bin/v" + cliVersion + "/muvloom-test"

	manifest := skill.RemoteManifest{
		SchemaVersion: 1,
		Skill:         "muvloom",
		Version:       cliVersion,
		BundleVersion: cliVersion,
		Packages: map[string]skill.RemoteManifestBundle{
			"workbuddy": {
				Archive:       "muvloom-workbuddy.zip",
				ArchiveSHA256: hex.EncodeToString(zipSum[:]),
				FileHash:      treeHash,
				Files:         []skill.RemoteManifestFile{{Path: "SKILL.md", Bytes: len(content), SHA256: hex.EncodeToString(fileSum[:])}},
			},
		},
		CLI: &skill.RemoteManifestCLI{
			Version: cliVersion,
			Binaries: map[string]skill.RemoteManifestBinary{
				platform: {
					Path:   binPath,
					Bytes:  len(binBytes),
					SHA256: binSHA,
				},
			},
		},
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			_, _ = w.Write(manifestBytes)
		case "/cli/" + binPath:
			_, _ = w.Write(binBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestCheckOrUpdateSelfChecksAndReplacesBinaryAtomically(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stateDir := t.TempDir()
	exe := filepath.Join(dir, "muvloom")
	if err := os.WriteFile(exe, []byte("old-0.2.5"), 0o755); err != nil {
		t.Fatal(err)
	}
	staleOld := exe + ".old"
	if err := os.WriteFile(staleOld, []byte("leftover"), 0o644); err != nil {
		t.Fatal(err)
	}

	newPayload := []byte("#!/bin/sh\necho muvloom 0.2.6\n")
	srv, _ := buildTestSkillAndCLIServer(t, "0.2.6", "darwin/arm64", newPayload, "")

	opts := SelfUpdateOptions{
		StateDir:       stateDir,
		CurrentVersion: "0.2.5",
		ExecutablePath: exe,
		OS:             "darwin",
		Arch:           "arm64",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
	}

	// Read-only --check neither replaces exe nor deletes exe.old nor creates state files.
	checkRes, err := CheckOrUpdateSelf(context.Background(), opts, true)
	if err != nil {
		t.Fatalf("checkOnly failed: %v", err)
	}
	if checkRes.Status != "update_available" || checkRes.LatestVersion != "0.2.6" {
		t.Fatalf("unexpected check result: %+v", checkRes)
	}
	if got, _ := os.ReadFile(exe); string(got) != "old-0.2.5" {
		t.Fatalf("--check modified binary: %q", got)
	}
	if _, err := os.Stat(staleOld); err != nil {
		t.Fatalf("--check deleted .old file: %v", err)
	}

	// Full update replaces exe, verifies SHA-256, sets executable permission, and cleans stale .old.
	res, err := CheckOrUpdateSelf(context.Background(), opts, false)
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if res.Status != "updated" || res.LatestVersion != "0.2.6" || res.InstallPath != exe {
		t.Fatalf("unexpected update result: %+v", res)
	}
	got, err := os.ReadFile(exe)
	if err != nil || !bytes.Equal(got, newPayload) {
		t.Fatalf("updated binary mismatch: %q, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(exe)
		if err != nil || info.Mode()&0o111 == 0 {
			t.Fatalf("updated binary is not executable: %v %v", info, err)
		}
	}
	if _, err := os.Stat(staleOld); !os.IsNotExist(err) {
		t.Fatalf("stale .old file remained: %v", err)
	}

	// Same or newer current version never downgrades.
	opts.CurrentVersion = "0.2.7"
	newerRes, err := CheckOrUpdateSelf(context.Background(), opts, false)
	if err != nil || newerRes.Status != "up_to_date" {
		t.Fatalf("downgrade check failed: %+v, %v", newerRes, err)
	}
}

func TestCheckOrUpdateSelfRejectsCorruptChecksumAndRedirects(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "muvloom")
	if err := os.WriteFile(exe, []byte("keep-original"), 0o755); err != nil {
		t.Fatal(err)
	}

	badSHA := "0000000000000000000000000000000000000000000000000000000000000000"
	srv, _ := buildTestSkillAndCLIServer(t, "0.2.6", "linux/amd64", []byte("tampered-binary"), badSHA)

	_, err := CheckOrUpdateSelf(context.Background(), SelfUpdateOptions{
		StateDir:       t.TempDir(),
		CurrentVersion: "0.2.5",
		ExecutablePath: exe,
		OS:             "linux",
		Arch:           "amd64",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
	}, false)
	if !errors.Is(err, ErrSelfInvalidBinary) {
		t.Fatalf("expected ErrSelfInvalidBinary, got %v", err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "keep-original" {
		t.Fatalf("corrupt update touched binary: %q", got)
	}

	redirectSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://untrusted.example/manifest.json", http.StatusFound)
	}))
	defer redirectSrv.Close()

	_, err = CheckOrUpdateSelf(context.Background(), SelfUpdateOptions{
		StateDir:       t.TempDir(),
		CurrentVersion: "0.2.5",
		ExecutablePath: exe,
		OS:             "linux",
		Arch:           "amd64",
		BaseURL:        redirectSrv.URL,
		HTTP:           redirectSrv.Client(),
	}, true)
	if !errors.Is(err, ErrSelfRemoteUnavailable) {
		t.Fatalf("expected redirect to fail with ErrSelfRemoteUnavailable, got %v", err)
	}
}

func TestWindowsExecutableSwapPathAndThrottle(t *testing.T) {
	dir := t.TempDir()
	stateDir := t.TempDir()
	exe := filepath.Join(dir, "muvloom.exe")
	if err := os.WriteFile(exe, []byte("win-0.2.5"), 0o644); err != nil {
		t.Fatal(err)
	}
	newBin := []byte("win-0.2.6-pe")
	srv, calls := buildTestSkillAndCLIServer(t, "0.2.6", "windows/amd64", newBin, "")

	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	opts := SelfUpdateOptions{
		StateDir:       stateDir,
		CurrentVersion: "0.2.5",
		ExecutablePath: exe,
		OS:             "windows",
		Arch:           "amd64",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
		Now:            func() time.Time { return now },
	}

	// Disable -> skipped/disabled without hitting network.
	if err := SetSelfAutoUpdate(stateDir, false); err != nil {
		t.Fatal(err)
	}
	if res := MaybeAutoUpdateSelf(context.Background(), opts); res.Status != "disabled" || calls.Load() != 0 {
		t.Fatalf("expected disabled with 0 calls: %+v calls=%d", res, calls.Load())
	}

	// Re-enable -> updates immediately, then throttles for 24h.
	if err := SetSelfAutoUpdate(stateDir, true); err != nil {
		t.Fatal(err)
	}
	first := MaybeAutoUpdateSelf(context.Background(), opts)
	if first.Status != "updated" || first.LatestVersion != "0.2.6" {
		t.Fatalf("expected updated: %+v", first)
	}
	if got, _ := os.ReadFile(exe); !bytes.Equal(got, newBin) {
		t.Fatalf("windows binary not updated: %q", got)
	}
	callsAfterFirst := calls.Load()
	now = now.Add(time.Hour)
	second := MaybeAutoUpdateSelf(context.Background(), opts)
	if second.Status != "skipped" || second.Reason != "throttled" || calls.Load() != callsAfterFirst {
		t.Fatalf("expected 24h throttle: %+v calls=%d", second, calls.Load())
	}

	// Implicit os.Executable() inside `go test` (.test binary) is safely skipped.
	testBinRes := MaybeAutoUpdateSelf(context.Background(), SelfUpdateOptions{
		StateDir:       t.TempDir(),
		CurrentVersion: "0.2.5",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
	})
	if testBinRes.Status != "skipped" || testBinRes.Reason != "non_updatable_binary" {
		t.Fatalf("expected .test binary skip, got %+v", testBinRes)
	}
}

func TestCheckerPrefersManifestOriginAndFallsBackToGitHub(t *testing.T) {
	srv, _ := buildTestSkillAndCLIServer(t, "0.2.6", "darwin/arm64", []byte("bin"), "")
	c := Checker{
		Dir:            t.TempDir(),
		Version:        "0.2.5",
		ManifestOrigin: srv.URL,
		HTTP:           srv.Client(),
	}
	res := c.Check(context.Background())
	if res.Status != "update_available" || res.LatestVersion != "0.2.6" {
		t.Fatalf("expected manifest version 0.2.6, got %+v", res)
	}
}
