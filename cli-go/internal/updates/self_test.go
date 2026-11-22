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

	// Full update on Unix replaces exe, verifies SHA-256, sets executable permission, and preserves user's manual .old file.
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
	if _, err := os.Stat(staleOld); err != nil {
		t.Fatalf("Unix update deleted user's manual .old file: %v", err)
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
	staleWinOld := windowsOldBackupPath(exe)
	if err := os.WriteFile(staleWinOld, []byte("leftover-win"), 0o644); err != nil {
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
	if _, err := os.Stat(staleWinOld); !os.IsNotExist(err) {
		t.Fatalf("stale .muvloom-old remained on windows: %v", err)
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

	// Corrupted self-update.json fails closed (does not overwrite binary after a prior --auto off).
	corruptState := t.TempDir()
	corruptExe := filepath.Join(dir, "muvloom-corrupt.exe")
	if err := os.WriteFile(corruptExe, []byte("win-0.2.5"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(corruptState, "updates"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(corruptState, "updates", "self-update.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	corruptRes := MaybeAutoUpdateSelf(context.Background(), SelfUpdateOptions{
		StateDir:       corruptState,
		CurrentVersion: "0.2.5",
		ExecutablePath: corruptExe,
		OS:             "windows",
		Arch:           "amd64",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
	})
	if corruptRes.Status != "unavailable" || corruptRes.Reason != "state_unreadable" || corruptRes.AutoUpdate {
		t.Fatalf("expected fail-closed state_unreadable, got %+v", corruptRes)
	}
	if got, _ := os.ReadFile(corruptExe); string(got) != "win-0.2.5" {
		t.Fatalf("corrupted state must not replace executable, got %q", got)
	}
}

func TestCheckerPrefersManifestOriginAndFallsBackToGitHub(t *testing.T) {
	srv1, _ := buildTestSkillAndCLIServer(t, "0.2.6", "darwin/arm64", []byte("bin"), "")
	srv2, _ := buildTestSkillAndCLIServer(t, "0.2.9", "darwin/arm64", []byte("bin2"), "")
	stateDir := t.TempDir()
	c1 := Checker{
		Dir:            stateDir,
		Version:        "0.2.5",
		ManifestOrigin: srv1.URL,
		HTTP:           srv1.Client(),
	}
	res1 := c1.Check(context.Background())
	if res1.Status != "update_available" || res1.LatestVersion != "0.2.6" {
		t.Fatalf("expected manifest version 0.2.6, got %+v", res1)
	}

	// Switching ManifestOrigin on the same day invalidates cache instead of returning srv1's version.
	c2 := Checker{
		Dir:            stateDir,
		Version:        "0.2.5",
		ManifestOrigin: srv2.URL,
		HTTP:           srv2.Client(),
	}
	res2 := c2.Check(context.Background())
	if res2.Cached || res2.LatestVersion != "0.2.9" {
		t.Fatalf("expected fresh check for switched ManifestOrigin, got %+v", res2)
	}

	// Unix CleanStaleOldBinary never touches user's manual `<exe>.old`; Windows recovery restores `.<exe>.muvloom-old`.
	binDir := t.TempDir()
	unixExe := filepath.Join(binDir, "muvloom")
	userBackup := unixExe + ".old"
	if err := os.WriteFile(unixExe, []byte("cur"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userBackup, []byte("manual-backup"), 0o755); err != nil {
		t.Fatal(err)
	}
	cleanOrHealWindowsOldBinary(unixExe, "linux")
	if _, err := os.Stat(userBackup); err != nil {
		t.Fatalf("non-Windows cleanup deleted user's manual .old backup: %v", err)
	}

	winExe := filepath.Join(binDir, "muvloom.exe")
	winUpdaterBackup := windowsOldBackupPath(winExe)
	if err := os.WriteFile(winUpdaterBackup, []byte("win-recovered"), 0o644); err != nil {
		t.Fatal(err)
	}
	cleanOrHealWindowsOldBinary(winExe, "windows")
	if got, err := os.ReadFile(winExe); err != nil || string(got) != "win-recovered" {
		t.Fatalf("interrupted Windows swap was not healed from .muvloom-old: %q %v", got, err)
	}
}

func TestSelfUpdateRefetchesManifestOnBinary404AndShortFailureCooldown(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "muvloom")
	if err := os.WriteFile(exe, []byte("old-0.2.5"), 0o755); err != nil {
		t.Fatal(err)
	}

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	wZip, err := zw.Create("muvloom/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	skillContent := []byte("---\nname: muvloom\ndescription: Test\n---\n# Test\n")
	_, _ = wZip.Write(skillContent)
	_ = zw.Close()
	zipBytes := zipBuf.Bytes()
	zipSum := sha256.Sum256(zipBytes)
	fileSum := sha256.Sum256(skillContent)
	th := sha256.New()
	fmt.Fprintf(th, "%s\x00%d\x00", "SKILL.md", len(skillContent))
	th.Write(skillContent)
	treeHash := hex.EncodeToString(th.Sum(nil))

	newBin := []byte("fresh-deployed-0.2.8")
	binSum := sha256.Sum256(newBin)
	binSHA := hex.EncodeToString(binSum[:])

	var manifestFetches atomic.Int32
	var failAll atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failAll.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			n := manifestFetches.Add(1)
			binPath := "bin/v0.2.8/muvloom_darwin_arm64-stale0000000"
			if n >= 2 {
				binPath = "bin/v0.2.8/muvloom_darwin_arm64-" + binSHA[:12]
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(skill.RemoteManifest{
				SchemaVersion: 1,
				Skill:         "muvloom",
				Version:       "0.2.8",
				BundleVersion: "0.2.8",
				Packages: map[string]skill.RemoteManifestBundle{
					"workbuddy": {
						Archive:       "muvloom-workbuddy.zip",
						ArchiveSHA256: hex.EncodeToString(zipSum[:]),
						FileHash:      treeHash,
						Files:         []skill.RemoteManifestFile{{Path: "SKILL.md", Bytes: len(skillContent), SHA256: hex.EncodeToString(fileSum[:])}},
					},
				},
				CLI: &skill.RemoteManifestCLI{
					Version: "0.2.8",
					Binaries: map[string]skill.RemoteManifestBinary{
						"darwin/arm64": {Path: binPath, SHA256: binSHA, Bytes: len(newBin)},
					},
				},
			})
		case "/cli/bin/v0.2.8/muvloom_darwin_arm64-" + binSHA[:12]:
			_, _ = w.Write(newBin)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	// 1. Transient 502 backs off for 5 minutes rather than locking out auto-update for 24 hours.
	stateDir := t.TempDir()
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	failAll.Store(true)
	opts := SelfUpdateOptions{
		StateDir:       stateDir,
		CurrentVersion: "0.2.5",
		ExecutablePath: exe,
		OS:             "darwin",
		Arch:           "arm64",
		BaseURL:        srv.URL,
		HTTP:           srv.Client(),
		Now:            func() time.Time { return now },
	}
	failedRes := MaybeAutoUpdateSelf(context.Background(), opts)
	if failedRes.Status != "unavailable" {
		t.Fatalf("expected unavailable on 502, got %+v", failedRes)
	}
	now = now.Add(6 * time.Minute)
	failAll.Store(false)

	// 2. After 6 minutes, auto-update retries; first binary URL 404s, triggers 1 manifest re-fetch, and updates!
	recovered := MaybeAutoUpdateSelf(context.Background(), opts)
	if recovered.Status != "updated" || recovered.LatestVersion != "0.2.8" {
		t.Fatalf("expected 404 manifest re-fetch to succeed, got %+v", recovered)
	}
	if manifestFetches.Load() != 2 {
		t.Fatalf("expected exactly 2 manifest fetches across 404 retry, got %d", manifestFetches.Load())
	}
	if got, _ := os.ReadFile(exe); !bytes.Equal(got, newBin) {
		t.Fatalf("binary not updated after manifest re-fetch: %q", got)
	}
}
