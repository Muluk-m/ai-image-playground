package skill

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func buildTestSkillZip(t *testing.T, entries map[string][]byte) ([]byte, string, []RemoteManifestFile) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	var bfiles []bundleFile
	var mfiles []RemoteManifestFile
	for rel, data := range entries {
		w, err := zw.Create("muvloom/" + rel)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
		if rel == ".muvloom-skill.json" {
			continue
		}
		bfiles = append(bfiles, bundleFile{path: rel, data: data})
		sum := sha256.Sum256(data)
		mfiles = append(mfiles, RemoteManifestFile{
			Path:   rel,
			Bytes:  len(data),
			SHA256: hex.EncodeToString(sum[:]),
		})
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), hashFiles(bfiles), mfiles
}

func makeRemoteFixtureServer(
	t *testing.T,
	version string,
	workbuddyEntries map[string][]byte,
	cliEntries map[string][]byte,
	manifestHits *atomic.Int32,
	archiveHits *atomic.Int32,
) *httptest.Server {
	t.Helper()
	wbZip, wbHash, wbFiles := buildTestSkillZip(t, workbuddyEntries)
	cliZip, cliHash, cliFiles := buildTestSkillZip(t, cliEntries)
	wbZipSum := sha256.Sum256(wbZip)
	cliZipSum := sha256.Sum256(cliZip)
	manifest := RemoteManifest{
		SchemaVersion: 1,
		Skill:         "muvloom",
		Version:       version,
		BundleVersion: BundleVersion,
		Packages: map[string]RemoteManifestBundle{
			"workbuddy": {
				Archive:       "muvloom-workbuddy.zip",
				ArchiveSHA256: hex.EncodeToString(wbZipSum[:]),
				FileHash:      wbHash,
				Files:         wbFiles,
			},
			"claude-code": {
				Archive:       "muvloom-cli-skill.zip",
				ArchiveSHA256: hex.EncodeToString(cliZipSum[:]),
				FileHash:      cliHash,
				Files:         cliFiles,
			},
			"codex": {
				Archive:       "muvloom-cli-skill.zip",
				ArchiveSHA256: hex.EncodeToString(cliZipSum[:]),
				FileHash:      cliHash,
				Files:         cliFiles,
			},
		},
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("remote skill fetch sent auth header or cookie: %v", r.Header)
		}
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			if manifestHits != nil {
				manifestHits.Add(1)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestBytes)
		case "/cli/muvloom-workbuddy.zip":
			if archiveHits != nil {
				archiveHits.Add(1)
			}
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(wbZip)
		case "/cli/muvloom-cli-skill.zip":
			if archiveHits != nil {
				archiveHits.Add(1)
			}
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(cliZip)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestManifestOriginForAPIAllowlist(t *testing.T) {
	cases := map[string]string{
		"https://api.muvloom.online":       "https://muvloom.online",
		"https://api.muvloom.online/":      "https://muvloom.online",
		"https://test-api.muvloom.online":  "https://test.muvloom.online",
		"https://image-api.qiliangjia.one": "https://image-playground.qiliangjia.one",
	}
	for api, want := range cases {
		got, ok := ManifestOriginForAPI(api)
		if !ok || got != want {
			t.Fatalf("ManifestOriginForAPI(%q) = (%q, %v), want (%q, true)", api, got, ok, want)
		}
	}
	for _, bad := range []string{"", "http://api.muvloom.online", "https://evil.example.com", "http://127.0.0.1:37377"} {
		if got, ok := ManifestOriginForAPI(bad); ok {
			t.Fatalf("ManifestOriginForAPI(%q) unexpectedly matched %q", bad, got)
		}
	}
}

func TestMaybeAutoUpdateHotUpdatesInPlaceThrottlesAndPreservesEditedCopies(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	wbInstall, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	claudeInstall, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	codexInstall, err := Install(InstallOptions{Host: "codex", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	// Hand-edit codex so it must NOT be overwritten by auto-update.
	if err := os.WriteFile(filepath.Join(codexInstall.Path, "SKILL.md"), []byte("user custom"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Record WorkBuddy SKILL.md inode before update to confirm in-place replacement (no rename/delete).
	beforeStat, err := os.Stat(filepath.Join(wbInstall.Path, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}

	var manifestHits, archiveHits atomic.Int32
	nextVersion := SkillVersion + ".1"
	server := makeRemoteFixtureServer(
		t,
		nextVersion,
		map[string][]byte{
			"SKILL.md":                []byte("---\nname: muvloom\ndescription: Hot updated WorkBuddy\n---\n# New WB\n"),
			"references/workbuddy.md": []byte("# Updated WorkBuddy ref\n"),
			"references/new-guide.md": []byte("# Brand new guide\n"),
			".muvloom-skill.json":     []byte(`{"skill":"muvloom","version":"ignored"}`),
		},
		map[string][]byte{
			"SKILL.md":          []byte("---\nname: muvloom\ndescription: Hot updated CLI\n---\n# New CLI\n"),
			"agents/openai.yaml": []byte("name: muvloom\n"),
		},
		&manifestHits,
		&archiveHits,
	)
	defer server.Close()

	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	opts := RemoteUpdateOptions{
		Home:     home,
		CWD:      cwd,
		StateDir: stateDir,
		BaseURL:  server.URL,
		HTTP:     server.Client(),
		Now:      func() time.Time { return now },
	}
	res := MaybeAutoUpdate(context.Background(), opts)
	if res.Status != "updated" || res.RemoteVersion != nextVersion || len(res.Updated) != 2 {
		t.Fatalf("unexpected auto-update result: %+v", res)
	}
	if manifestHits.Load() != 1 || archiveHits.Load() != 2 {
		t.Fatalf("hits = manifest:%d archive:%d, want 1 and 2", manifestHits.Load(), archiveHits.Load())
	}

	// Verify WorkBuddy was updated IN PLACE (same inode on POSIX) and obsolete files were removed.
	afterStat, err := os.Stat(filepath.Join(wbInstall.Path, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && !os.SameFile(beforeStat, afterStat) {
		t.Fatal("WorkBuddy SKILL.md was replaced via rename instead of updated in place")
	}
	if data, _ := os.ReadFile(filepath.Join(wbInstall.Path, "references", "new-guide.md")); string(data) != "# Brand new guide\n" {
		t.Fatalf("new file missing: %q", data)
	}
	if _, err := os.Stat(filepath.Join(wbInstall.Path, "references", "cli.md")); !os.IsNotExist(err) {
		t.Fatalf("obsolete file was not removed: %v", err)
	}
	// Verify edited codex copy stayed untouched.
	if data, _ := os.ReadFile(filepath.Join(codexInstall.Path, "SKILL.md")); string(data) != "user custom" {
		t.Fatalf("edited codex copy was overwritten: %q", data)
	}
	// Verify hot-updated copies report Intact=true, Current=true, and RefreshOutdated does NOT downgrade them!
	installed, failed, err := RefreshOutdated(home, cwd)
	if err != nil || len(failed) != 0 {
		t.Fatalf("RefreshOutdated after hot-update: %v %v", failed, err)
	}
	for _, item := range installed {
		if item.Host == "workbuddy" || item.Host == "claude-code" {
			if !item.Intact || !item.Current || item.Version != nextVersion {
				t.Fatalf("hot-updated %s downgraded or invalid: %+v", item.Host, item)
			}
		}
	}
	if data, _ := os.ReadFile(filepath.Join(claudeInstall.Path, "SKILL.md")); !strings.Contains(string(data), "Hot updated CLI") {
		t.Fatalf("claude-code SKILL.md was downgraded: %q", data)
	}

	// Second call within 24 hours must be throttled with ZERO network requests.
	now = now.Add(2 * time.Hour)
	throttled := MaybeAutoUpdate(context.Background(), opts)
	if throttled.Status != "skipped" || throttled.Reason != "throttled" || manifestHits.Load() != 1 {
		t.Fatalf("second call not throttled: %+v hits=%d", throttled, manifestHits.Load())
	}

	// After 24 hours, checks once more and reports up_to_date.
	now = now.Add(23 * time.Hour)
	again := MaybeAutoUpdate(context.Background(), opts)
	if again.Status != "up_to_date" || manifestHits.Load() != 2 {
		t.Fatalf("after 24h = %+v hits=%d", again, manifestHits.Load())
	}
}

func TestMaybeAutoUpdateRespectsDisableToggleAndNeverDowngrades(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if err := SetAutoUpdate(stateDir, false); err != nil {
		t.Fatal(err)
	}
	if AutoUpdateEnabled(stateDir) {
		t.Fatal("AutoUpdateEnabled returned true after disabling")
	}

	var hits atomic.Int32
	server := makeRemoteFixtureServer(
		t,
		"9.9.9",
		map[string][]byte{"SKILL.md": []byte("# 9.9.9\n")},
		map[string][]byte{"SKILL.md": []byte("# 9.9.9\n")},
		&hits,
		nil,
	)
	defer server.Close()

	opts := RemoteUpdateOptions{Home: home, CWD: cwd, StateDir: stateDir, BaseURL: server.URL, HTTP: server.Client()}
	autoRes := MaybeAutoUpdate(context.Background(), opts)
	if autoRes.Status != "disabled" || hits.Load() != 0 {
		t.Fatalf("disabled auto-update hit network: %+v hits=%d", autoRes, hits.Load())
	}

	// Explicit CheckOrUpdateRemote ignores the auto_update=false toggle!
	checkRes, err := CheckOrUpdateRemote(context.Background(), opts, true)
	if err != nil || checkRes.Status != "update_available" || checkRes.RemoteVersion != "9.9.9" {
		t.Fatalf("explicit check failed: %+v %v", checkRes, err)
	}
	updRes, err := CheckOrUpdateRemote(context.Background(), opts, false)
	if err != nil || updRes.Status != "updated" || len(updRes.Updated) != 1 {
		t.Fatalf("explicit update failed: %+v %v", updRes, err)
	}

	// Remote serving an older version must never downgrade the 9.9.9 install.
	oldServer := makeRemoteFixtureServer(
		t,
		"0.2.6",
		map[string][]byte{"SKILL.md": []byte("# old\n")},
		map[string][]byte{"SKILL.md": []byte("# old\n")},
		nil,
		nil,
	)
	defer oldServer.Close()
	opts.BaseURL = oldServer.URL
	opts.HTTP = oldServer.Client()
	noDowngrade, err := CheckOrUpdateRemote(context.Background(), opts, false)
	if err != nil || noDowngrade.Status != "up_to_date" {
		t.Fatalf("older remote triggered downgrade: %+v %v", noDowngrade, err)
	}
	if data, _ := os.ReadFile(filepath.Join(res.Path, "SKILL.md")); string(data) != "# 9.9.9\n" {
		t.Fatalf("9.9.9 copy was downgraded: %q", data)
	}
}

func TestRemoteUpdateRejectsRedirectsTamperedChecksumsAndUnsafeZips(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	if _, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}

	t.Run("rejects redirect", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://evil.example.com/manifest.json", http.StatusFound)
		}))
		defer srv.Close()
		_, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
			Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
		}, false)
		if err == nil {
			t.Fatal("accepted redirect on manifest fetch")
		}
	})

	t.Run("rejects tampered zip checksum", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/cli/skill-manifest.json" {
				_, _ = w.Write([]byte(`{
					"schema_version":1,"skill":"muvloom","version":"9.9.9","bundle_version":"0.2.6",
					"packages":{"claude-code":{"archive":"muvloom-cli-skill.zip","archive_sha256":"` + strings.Repeat("a", 64) + `","file_hash":"` + strings.Repeat("b", 64) + `","files":[{"path":"SKILL.md","bytes":5,"sha256":"` + strings.Repeat("c", 64) + `"}]}}
				}`))
				return
			}
			_, _ = w.Write([]byte("tampered zip bytes"))
		}))
		defer srv.Close()
		_, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
			Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
		}, false)
		if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
			t.Fatalf("expected checksum mismatch, got %v", err)
		}
	})

	t.Run("rejects symlink entry in zip", func(t *testing.T) {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		hdr := &zip.FileHeader{Name: "muvloom/SKILL.md"}
		hdr.SetMode(fs.ModeSymlink | 0o777)
		w, _ := zw.CreateHeader(hdr)
		_, _ = w.Write([]byte("/etc/passwd"))
		_ = zw.Close()
		zipBytes := buf.Bytes()
		zipSum := sha256.Sum256(zipBytes)
		fileSum := sha256.Sum256([]byte("/etc/passwd"))
		manifest := RemoteManifest{
			SchemaVersion: 1, Skill: "muvloom", Version: "9.9.9", BundleVersion: "0.2.6",
			Packages: map[string]RemoteManifestBundle{
				"claude-code": {
					Archive:       "muvloom-cli-skill.zip",
					ArchiveSHA256: hex.EncodeToString(zipSum[:]),
					FileHash:      hashFiles([]bundleFile{{path: "SKILL.md", data: []byte("/etc/passwd")}}),
					Files:         []RemoteManifestFile{{Path: "SKILL.md", Bytes: len("/etc/passwd"), SHA256: hex.EncodeToString(fileSum[:])}},
				},
			},
		}
		mBytes, _ := json.Marshal(manifest)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/cli/skill-manifest.json" {
				_, _ = w.Write(mBytes)
				return
			}
			_, _ = w.Write(zipBytes)
		}))
		defer srv.Close()
		_, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
			Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
		}, false)
		if err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("expected symlink rejection, got %v", err)
		}
	})
}

func TestMaybeAutoUpdateSkipsNetworkWhenNoSkillsInstalled(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()

	res := MaybeAutoUpdate(context.Background(), RemoteUpdateOptions{
		Home:     t.TempDir(),
		CWD:      t.TempDir(),
		StateDir: t.TempDir(),
		BaseURL:  srv.URL,
		HTTP:     srv.Client(),
	})
	if res.Status != "skipped" || res.Reason != "no_refreshable_skills" || hits.Load() != 0 {
		t.Fatalf("expected zero network hits with no skills: %+v hits=%d", res, hits.Load())
	}
}

func TestRemoteUpdateCheckOnlyIsStrictlyReadOnly(t *testing.T) {
	home, cwd := t.TempDir(), t.TempDir()
	if _, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(t.TempDir(), "nonexistent-state")
	srv := makeRemoteFixtureServer(
		t,
		SkillVersion+".1",
		map[string][]byte{"SKILL.md": []byte("# new\n")},
		map[string][]byte{"SKILL.md": []byte("# new\n")},
		nil,
		nil,
	)
	defer srv.Close()

	res, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
	}, true)
	if err != nil || res.Status != "update_available" {
		t.Fatalf("checkOnly failed: %+v %v", res, err)
	}
	if _, statErr := os.Stat(stateDir); !os.IsNotExist(statErr) {
		t.Fatalf("checkOnly created local state directory: %v", statErr)
	}
}

func TestRemoteUpdateHandlesCaseOnlyFileRename(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	// Replace references/cli.md with references/CLI.md (case-only change on macOS/Windows).
	nextVer := SkillVersion + ".1"
	srv := makeRemoteFixtureServer(
		t,
		nextVer,
		map[string][]byte{
			"SKILL.md":          []byte("---\nname: muvloom\ndescription: Case test\n---\n# Case\n"),
			"references/CLI.md": []byte("# Uppercase CLI\n"),
		},
		map[string][]byte{"SKILL.md": []byte("# cli\n")},
		nil,
		nil,
	)
	defer srv.Close()

	upd, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
	}, false)
	if err != nil || upd.Status != "updated" {
		t.Fatalf("case-only rename update failed: %+v %v", upd, err)
	}
	installed, err := Installed(home, cwd)
	if err != nil || len(installed) != 1 || !installed[0].Intact || !installed[0].Current || installed[0].Version != nextVer {
		t.Fatalf("after case-only rename Installed = %+v, %v", installed, err)
	}
	if data, err := os.ReadFile(filepath.Join(res.Path, "references", "CLI.md")); err != nil || string(data) != "# Uppercase CLI\n" {
		t.Fatalf("case-renamed file missing or wrong: %q %v", data, err)
	}
}

func TestRemoteUpdateVerifiesSharedArchivePerHostAndReportsPartialFailures(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	if _, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "codex", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	cliZip, cliHash, cliFiles := buildTestSkillZip(t, map[string][]byte{
		"SKILL.md": []byte("---\nname: muvloom\ndescription: Shared\n---\n# Shared\n"),
	})
	cliSum := sha256.Sum256(cliZip)
	manifest := RemoteManifest{
		SchemaVersion: 1, Skill: "muvloom", Version: SkillVersion + ".1", BundleVersion: BundleVersion,
		Packages: map[string]RemoteManifestBundle{
			"claude-code": {
				Archive:       "muvloom-cli-skill.zip",
				ArchiveSHA256: hex.EncodeToString(cliSum[:]),
				FileHash:      cliHash,
				Files:         cliFiles,
			},
			// Intentionally wrong file_hash for codex sharing the same archive name.
			"codex": {
				Archive:       "muvloom-cli-skill.zip",
				ArchiveSHA256: hex.EncodeToString(cliSum[:]),
				FileHash:      strings.Repeat("0", 64),
				Files:         cliFiles,
			},
		},
	}
	mBytes, _ := json.Marshal(manifest)
	var archiveHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			_, _ = w.Write(mBytes)
		case "/cli/muvloom-cli-skill.zip":
			archiveHits.Add(1)
			_, _ = w.Write(cliZip)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	res, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
	}, false)
	if err != nil {
		t.Fatalf("partial update returned fatal err: %v", err)
	}
	if archiveHits.Load() != 1 {
		t.Fatalf("shared archive downloaded %d times, want 1", archiveHits.Load())
	}
	if res.Status != "partial" || len(res.Updated) != 1 || res.Updated[0].Host != "claude-code" || len(res.Failed) != 1 || res.Failed[0].Host != "codex" {
		t.Fatalf("expected partial result with claude-code updated and codex failed: %+v", res)
	}
}

func TestValidateManifestRejectsCaseVariantMetadataFile(t *testing.T) {
	bad := RemoteManifest{
		SchemaVersion: 1, Skill: "muvloom", Version: "9.9.9", BundleVersion: "0.2.6",
		Packages: map[string]RemoteManifestBundle{
			"claude-code": {
				Archive:       "muvloom-cli-skill.zip",
				ArchiveSHA256: strings.Repeat("a", 64),
				FileHash:      strings.Repeat("b", 64),
				Files:         []RemoteManifestFile{{Path: ".MUVLOOM-SKILL.JSON", Bytes: 2, SHA256: strings.Repeat("c", 64)}},
			},
		},
	}
	if err := validateManifest(bad); err == nil {
		t.Fatal("accepted case-variant .MUVLOOM-SKILL.JSON in manifest")
	}
}

func TestRemoteUpdateHandlesDirectoryCaseRenameAndFileDirTransitions(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}

	// Step 1: Directory-level case rename (references/ -> References/) + file -> dir transition (references/cli.md -> References/topic/guide.md)
	v1 := SkillVersion + ".1"
	srv1 := makeRemoteFixtureServer(
		t,
		v1,
		map[string][]byte{
			"SKILL.md":              []byte("# v1\n"),
			"References/topic.md":   []byte("# file form\n"),
		},
		map[string][]byte{"SKILL.md": []byte("# cli\n")},
		nil, nil,
	)
	defer srv1.Close()
	if upd, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv1.URL, HTTP: srv1.Client(),
	}, false); err != nil || upd.Status != "updated" {
		t.Fatalf("directory case rename failed: %+v %v", upd, err)
	}
	if installed, err := Installed(home, cwd); err != nil || len(installed) != 1 || !installed[0].Intact || installed[0].Version != v1 {
		t.Fatalf("after dir case rename Installed = %+v, %v", installed, err)
	}

	// Step 2: File -> Directory transition: References/topic.md (file) becomes References/topic.md/guide.md (dir + file).
	v2 := SkillVersion + ".2"
	srv2 := makeRemoteFixtureServer(
		t,
		v2,
		map[string][]byte{
			"SKILL.md":                    []byte("# v2\n"),
			"References/topic.md/guide.md": []byte("# dir form\n"),
		},
		map[string][]byte{"SKILL.md": []byte("# cli\n")},
		nil, nil,
	)
	defer srv2.Close()
	if upd, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv2.URL, HTTP: srv2.Client(),
	}, false); err != nil || upd.Status != "updated" {
		t.Fatalf("file->dir transition failed: %+v %v", upd, err)
	}
	if installed, err := Installed(home, cwd); err != nil || len(installed) != 1 || !installed[0].Intact || installed[0].Version != v2 {
		t.Fatalf("after file->dir transition Installed = %+v, %v", installed, err)
	}

	// Step 3: Directory -> File transition: References/topic.md/guide.md reverts back to References/topic.md (file).
	v3 := SkillVersion + ".3"
	srv3 := makeRemoteFixtureServer(
		t,
		v3,
		map[string][]byte{
			"SKILL.md":            []byte("# v3\n"),
			"References/topic.md": []byte("# back to file\n"),
		},
		map[string][]byte{"SKILL.md": []byte("# cli\n")},
		nil, nil,
	)
	defer srv3.Close()
	if upd, err := CheckOrUpdateRemote(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv3.URL, HTTP: srv3.Client(),
	}, false); err != nil || upd.Status != "updated" {
		t.Fatalf("dir->file transition failed: %+v %v", upd, err)
	}
	if installed, err := Installed(home, cwd); err != nil || len(installed) != 1 || !installed[0].Intact || installed[0].Version != v3 {
		t.Fatalf("after dir->file transition Installed = %+v, %v", installed, err)
	}
	if data, err := os.ReadFile(filepath.Join(res.Path, "References", "topic.md")); err != nil || string(data) != "# back to file\n" {
		t.Fatalf("final file content mismatch: %q %v", data, err)
	}
}

func TestRecoverInterruptedUpdateJournalHealsCrashedUpdate(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := snapshotSkillDir(res.Path)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a crash mid-update: persisted journal exists, SKILL.md was truncated/corrupted,
	// and a stray new file was written before SIGKILL.
	journal := updateJournal{
		Root:        home,
		Destination: res.Path,
		Host:        "workbuddy",
		Scope:       "user",
		FromHash:    res.FileHash,
		Snapshot:    snap,
		Planned:     []string{"SKILL.md", "references/half-written.md"},
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "updates"), 0o700); err != nil {
		t.Fatal(err)
	}
	jBytes, _ := json.Marshal(journal)
	jPath := journalPathForDest(stateDir, res.Path)
	if err := os.WriteFile(jPath, jBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(res.Path, "SKILL.md"), []byte("corrupted mid-write"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(res.Path, "references", "half-written.md"), []byte("stray"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Next MaybeAutoUpdate recovers the crashed tree back to Intact=true, clears the journal,
	// and then applies the remote hot-update cleanly!
	nextVer := SkillVersion + ".1"
	srv := makeRemoteFixtureServer(
		t,
		nextVer,
		map[string][]byte{"SKILL.md": []byte("# recovered and updated\n")},
		map[string][]byte{"SKILL.md": []byte("# cli\n")},
		nil, nil,
	)
	defer srv.Close()

	upd := MaybeAutoUpdate(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
	})
	if upd.Status != "updated" || upd.RemoteVersion != nextVer {
		t.Fatalf("recovery + auto-update failed: %+v", upd)
	}
	if data, _ := os.ReadFile(jPath); len(bytes.TrimSpace(data)) != 0 {
		t.Fatalf("journal was not cleared after recovery: %q", data)
	}
	if installed, err := Installed(home, cwd); err != nil || len(installed) != 1 || !installed[0].Intact || installed[0].Version != nextVer {
		t.Fatalf("after recovery Installed = %+v, %v", installed, err)
	}
}

func TestMaybeAutoUpdateThrottlesPerInstalledProjectPath(t *testing.T) {
	home, stateDir := t.TempDir(), t.TempDir()
	projA := filepath.Join(t.TempDir(), "projA")
	projB := filepath.Join(t.TempDir(), "projB")
	for _, p := range []string{projA, projB} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "go.mod"), []byte("module example\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Install(InstallOptions{Host: "codex", Scope: "project", Home: home, CWD: p}); err != nil {
			t.Fatal(err)
		}
	}

	nextVer := SkillVersion + ".1"
	srv := makeRemoteFixtureServer(
		t,
		nextVer,
		map[string][]byte{"SKILL.md": []byte("# wb\n")},
		map[string][]byte{"SKILL.md": []byte("# updated project skill\n")},
		nil, nil,
	)
	defer srv.Close()

	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	resA := MaybeAutoUpdate(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: projA, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return now },
	})
	if resA.Status != "updated" || len(resA.Updated) != 1 {
		t.Fatalf("project A update failed: %+v", resA)
	}
	// Switching to Project B 1 minute later must NOT be blocked by Project A's 24h throttle!
	now = now.Add(time.Minute)
	resB := MaybeAutoUpdate(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: projB, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(), Now: func() time.Time { return now },
	})
	if resB.Status != "updated" || len(resB.Updated) != 1 {
		t.Fatalf("project B was starved by project A throttle: %+v", resB)
	}
}

func TestMaybeAutoUpdateRespectsBudgetAndCachesArchiveDownloadFailures(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	if _, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "codex", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	var archiveAttempts atomic.Int32
	manifest := RemoteManifest{
		SchemaVersion: 1, Skill: "muvloom", Version: SkillVersion + ".1", BundleVersion: BundleVersion,
		Packages: map[string]RemoteManifestBundle{
			"claude-code": {Archive: "muvloom-cli-skill.zip", ArchiveSHA256: strings.Repeat("a", 64), FileHash: strings.Repeat("b", 64), Files: []RemoteManifestFile{{Path: "SKILL.md", Bytes: 2, SHA256: strings.Repeat("c", 64)}}},
			"codex":       {Archive: "muvloom-cli-skill.zip", ArchiveSHA256: strings.Repeat("a", 64), FileHash: strings.Repeat("b", 64), Files: []RemoteManifestFile{{Path: "SKILL.md", Bytes: 2, SHA256: strings.Repeat("c", 64)}}},
		},
	}
	mBytes, _ := json.Marshal(manifest)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cli/skill-manifest.json" {
			_, _ = w.Write(mBytes)
			return
		}
		archiveAttempts.Add(1)
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer srv.Close()

	res := MaybeAutoUpdate(context.Background(), RemoteUpdateOptions{
		Home: home, CWD: cwd, StateDir: stateDir, BaseURL: srv.URL, HTTP: srv.Client(),
	})
	if res.Status != "unavailable" {
		t.Fatalf("expected unavailable, got %+v", res)
	}
	// Shared archive failed once -> must NOT be re-requested for codex.
	if archiveAttempts.Load() != 1 {
		t.Fatalf("archive download retried %d times across shared hosts, want 1", archiveAttempts.Load())
	}
}

func TestRecoverInterruptedUpdatePreservesNewerReinstallAndUserFiles(t *testing.T) {
	t.Run("already intact newer install clears stale journal without rolling back", func(t *testing.T) {
		home, stateDir := t.TempDir(), t.TempDir()
		res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
		if err != nil {
			t.Fatal(err)
		}
		// Simulate an older journal left behind before the user ran `skill install` to 0.2.6.
		oldSnap := map[string][]byte{
			"SKILL.md":            []byte("# ancient 0.1.0\n"),
			".muvloom-skill.json": []byte(`{"skill":"muvloom","version":"0.1.0","host":"workbuddy","scope":"user","file_hash":"` + strings.Repeat("1", 64) + `"}`),
		}
		jPath := journalPathForDest(stateDir, res.Path)
		if err := os.MkdirAll(filepath.Dir(jPath), 0o700); err != nil {
			t.Fatal(err)
		}
		jBytes, _ := json.Marshal(updateJournal{
			Root: home, Destination: res.Path, Host: "workbuddy", Scope: "user",
			FromHash: strings.Repeat("1", 64), Snapshot: oldSnap, Planned: []string{"SKILL.md"},
		})
		if err := os.WriteFile(jPath, jBytes, 0o600); err != nil {
			t.Fatal(err)
		}

		recoverInterruptedUpdates(context.Background(), stateDir, time.Second)
		// Current intact install must NOT be rolled back to 0.1.0, and stale journal is cleared.
		if data, _ := os.ReadFile(filepath.Join(res.Path, "SKILL.md")); strings.Contains(string(data), "ancient") {
			t.Fatal("recovery rolled back an intact newer installation")
		}
		if data, _ := os.ReadFile(jPath); len(bytes.TrimSpace(data)) != 0 {
			t.Fatalf("stale journal was not cleared: %q", data)
		}
	})

	t.Run("unexpected user-added file aborts recovery without deleting it", func(t *testing.T) {
		home, stateDir := t.TempDir(), t.TempDir()
		res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
		if err != nil {
			t.Fatal(err)
		}
		snap, err := snapshotSkillDir(res.Path)
		if err != nil {
			t.Fatal(err)
		}
		// Simulate interrupted update + user manually added custom-notes.txt afterward.
		userFile := filepath.Join(res.Path, "custom-notes.txt")
		if err := os.WriteFile(userFile, []byte("precious user notes"), 0o644); err != nil {
			t.Fatal(err)
		}
		jPath := journalPathForDest(stateDir, res.Path)
		if err := os.MkdirAll(filepath.Dir(jPath), 0o700); err != nil {
			t.Fatal(err)
		}
		jBytes, _ := json.Marshal(updateJournal{
			Root: home, Destination: res.Path, Host: "workbuddy", Scope: "user",
			FromHash: res.FileHash, Snapshot: snap, Planned: []string{"SKILL.md"},
		})
		if err := os.WriteFile(jPath, jBytes, 0o600); err != nil {
			t.Fatal(err)
		}

		recoverInterruptedUpdates(context.Background(), stateDir, time.Second)
		if data, err := os.ReadFile(userFile); err != nil || string(data) != "precious user notes" {
			t.Fatalf("recovery deleted or damaged user file: %q %v", data, err)
		}
	})
}

func TestRecoverInterruptedUpdateRefusesSymlinksBeforeDeleteOrWrite(t *testing.T) {
	home, stateDir := t.TempDir(), t.TempDir()
	outside := t.TempDir()
	outsideTarget := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(outsideTarget, []byte("do not touch"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := snapshotSkillDir(res.Path)
	if err != nil {
		t.Fatal(err)
	}

	// Replace SKILL.md with a symlink to outsideTarget AND add a symlinked scripts/ dir pointing outside.
	if err := os.Remove(filepath.Join(res.Path, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideTarget, filepath.Join(res.Path, "SKILL.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(res.Path, "scripts")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	jPath := journalPathForDest(stateDir, res.Path)
	if err := os.MkdirAll(filepath.Dir(jPath), 0o700); err != nil {
		t.Fatal(err)
	}
	jBytes, _ := json.Marshal(updateJournal{
		Root: home, Destination: res.Path, Host: "workbuddy", Scope: "user",
		FromHash: res.FileHash, Snapshot: snap, Planned: []string{"SKILL.md", "scripts/victim.txt"},
	})
	if err := os.WriteFile(jPath, jBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	recoverInterruptedUpdates(context.Background(), stateDir, time.Second)
	// Outside victim.txt must neither be deleted (via scripts/victim.txt) nor overwritten (via SKILL.md)!
	if data, err := os.ReadFile(outsideTarget); err != nil || string(data) != "do not touch" {
		t.Fatalf("recovery followed symlink outside Skill dir: %q %v", data, err)
	}
	// Journal stays intact when recovery refuses symlink.
	if data, _ := os.ReadFile(jPath); len(bytes.TrimSpace(data)) == 0 {
		t.Fatal("journal was cleared despite symlink refusal")
	}
}

func TestRecoverInterruptedUpdateRespectsExpiredContext(t *testing.T) {
	home, stateDir := t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := snapshotSkillDir(res.Path)
	if err != nil {
		t.Fatal(err)
	}
	jPath := journalPathForDest(stateDir, res.Path)
	if err := os.MkdirAll(filepath.Dir(jPath), 0o700); err != nil {
		t.Fatal(err)
	}
	jBytes, _ := json.Marshal(updateJournal{
		Root: home, Destination: res.Path, Host: "workbuddy", Scope: "user",
		FromHash: res.FileHash, Snapshot: snap, Planned: []string{"SKILL.md"},
	})
	if err := os.WriteFile(jPath, jBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	expiredCtx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	recoverInterruptedUpdates(expiredCtx, stateDir, 5*time.Second)
	if time.Since(start) > 500*time.Millisecond {
		t.Fatalf("recoverInterruptedUpdates ignored canceled context and took %v", time.Since(start))
	}
	if data, _ := os.ReadFile(jPath); len(bytes.TrimSpace(data)) == 0 {
		t.Fatal("journal was modified despite canceled context")
	}
}

func TestApplyInPlaceUpdateRecordsLockedSnapshotFromHash(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an outdated pre-lock Installation snapshot (stale FileHash) while disk holds
	// a newer intermediate version (res.FileHash) installed concurrently before lock acquisition.
	staleItem := Installation{
		Skill:      "muvloom",
		Host:       "workbuddy",
		Scope:      "user",
		Path:       res.Path,
		Version:    "0.2.5",
		FileHash:   strings.Repeat("9", 64),
		Intact:     true,
		foundHost:  "workbuddy",
		foundScope: "user",
	}
	// Force a post-write treeHash mismatch to trigger rollback with a bad targetHash, confirming
	// applyInPlaceUpdate uses the locked on-disk hash and restores cleanly without corrupting res.Path.
	newFiles := []bundleFile{{path: "SKILL.md", data: []byte("# next\n")}}
	if _, err := applyInPlaceUpdate(staleItem, home, cwd, stateDir, SkillVersion+".1", strings.Repeat("0", 64), newFiles, time.Second); err == nil {
		t.Fatal("expected treeHash mismatch error")
	}
	after, err := Installed(home, cwd)
	if err != nil || len(after) != 1 || !after[0].Intact || after[0].FileHash != res.FileHash {
		t.Fatalf("after rollback Installed = %+v, %v (want intact FileHash=%s)", after, err, res.FileHash)
	}
}
