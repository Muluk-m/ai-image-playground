package cli

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/updates"
)

type updateTransport func(*http.Request) (*http.Response, error)

func (f updateTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestUpdateCommandWorksWithoutLoginAndCachesItsResult(t *testing.T) {
	var out bytes.Buffer
	manifestCalls, githubCalls := 0, 0
	a := &App{APIURL: DefaultAPIURL, Store: auth.Store{Dir: t.TempDir()}, Out: &out, Err: io.Discard}
	a.HTTP = &http.Client{Transport: updateTransport(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" {
			t.Fatalf("update sent credentials on %s", req.URL)
		}
		switch req.URL.Host {
		case "muvloom.online":
			manifestCalls++
			// Simulate manifest unavailable so fallback to GitHub Releases is also exercised.
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("not found"))}, nil
		case "api.github.com":
			githubCalls++
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`[{"tag_name":"cli-v%s"}]`, Version)))}, nil
		default:
			t.Fatalf("update contacted unexpected host %s", req.URL)
			return nil, nil
		}
	})}
	for attempt := range 2 {
		out.Reset()
		if code := a.Run([]string{"--json", "update", "check"}); code != ExitOK {
			t.Fatalf("update check exit %d: %s", code, out.String())
		}
		var result struct {
			OK   bool `json:"ok"`
			Data struct {
				Status           string `json:"status"`
				Cached           bool   `json:"cached"`
				ShouldPrompt     bool   `json:"should_prompt"`
				InstallDirectory string `json:"install_directory"`
				CLIAutoUpdate    bool   `json:"cli_auto_update"`
				SkillAutoUpdate  bool   `json:"skill_auto_update"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.OK || result.Data.Status != "up_to_date" || result.Data.Cached != (attempt == 1) || result.Data.ShouldPrompt || result.Data.InstallDirectory == "" || !result.Data.CLIAutoUpdate || !result.Data.SkillAutoUpdate {
			t.Fatalf("bad command response: %s", out.String())
		}
	}
	if manifestCalls != 1 || githubCalls != 1 {
		t.Fatalf("check re-fetched manifest=%d github=%d", manifestCalls, githubCalls)
	}
}

func testManifestServer(t *testing.T, version string, body string) *httptest.Server {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("muvloom/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	content := []byte(body)
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zipBytes := buf.Bytes()
	zipSum := sha256.Sum256(zipBytes)
	fileSum := sha256.Sum256(content)
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00", "SKILL.md", len(content))
	h.Write(content)
	treeHash := hex.EncodeToString(h.Sum(nil))
	manifest := skill.RemoteManifest{
		SchemaVersion: 1,
		Skill:         "muvloom",
		Version:       version,
		BundleVersion: skill.BundleVersion,
		Packages: map[string]skill.RemoteManifestBundle{
			"workbuddy": {
				Archive:       "muvloom-workbuddy.zip",
				ArchiveSHA256: hex.EncodeToString(zipSum[:]),
				FileHash:      treeHash,
				Files:         []skill.RemoteManifestFile{{Path: "SKILL.md", Bytes: len(content), SHA256: hex.EncodeToString(fileSum[:])}},
			},
		},
	}
	manifestBytes, _ := json.Marshal(manifest)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			_, _ = w.Write(manifestBytes)
		case "/cli/muvloom-workbuddy.zip":
			_, _ = w.Write(zipBytes)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestUpdateSkillCommandFlagsCheckUpdateAndAuthStatusAutoHotUpdate(t *testing.T) {
	home, cwd, stateDir := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := skill.Install(skill.InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	nextVer := skill.SkillVersion + ".1"
	srv := testManifestServer(t, nextVer, "---\nname: muvloom\ndescription: Hot\n---\n# Hot\n")
	defer srv.Close()

	var out bytes.Buffer
	a := &App{
		APIURL:          DefaultAPIURL,
		Store:           auth.Store{Dir: stateDir},
		Home:            home,
		CWD:             cwd,
		ManifestBaseURL: srv.URL,
		HTTP:            srv.Client(),
		Out:             &out,
		Err:             io.Discard,
	}

	// Mutual exclusion and validation on flags.
	if code := a.Run([]string{"--json", "update", "skill", "--check", "--auto", "off"}); code != ExitInvalid {
		t.Fatalf("expected ExitInvalid for --check + --auto, got %d: %s", code, out.String())
	}
	out.Reset()
	if code := a.Run([]string{"--json", "update", "skill", "--auto", "maybe"}); code != ExitInvalid {
		t.Fatalf("expected ExitInvalid for bad --auto, got %d: %s", code, out.String())
	}

	// Disable auto-update -> verify auth status does not touch disk.
	out.Reset()
	if code := a.Run([]string{"--json", "update", "skill", "--auto", "off"}); code != ExitOK {
		t.Fatalf("auto off failed %d: %s", code, out.String())
	}
	if skill.AutoUpdateEnabled(stateDir) {
		t.Fatal("auto update still enabled after --auto off")
	}

	// Explicit --check detects update without modifying files.
	out.Reset()
	if code := a.Run([]string{"--json", "update", "skill", "--check"}); code != ExitOK {
		t.Fatalf("update skill --check failed %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), `"status":"update_available"`) {
		t.Fatalf("unexpected --check output: %s", out.String())
	}

	// Re-enable auto-update and run auth status -> silent hot-update applies!
	out.Reset()
	if code := a.Run([]string{"--json", "update", "skill", "--auto", "on"}); code != ExitOK {
		t.Fatalf("auto on failed %d: %s", code, out.String())
	}
	out.Reset()
	if code := a.Run([]string{"--json", "auth", "status"}); code != ExitOK {
		t.Fatalf("auth status failed %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), fmt.Sprintf(`"version":"%s"`, nextVer)) {
		t.Fatalf("auth status did not report hot-updated skill version %s: %s", nextVer, out.String())
	}
	if data, _ := os.ReadFile(filepath.Join(res.Path, "SKILL.md")); !strings.Contains(string(data), "# Hot") {
		t.Fatalf("WorkBuddy SKILL.md was not hot-updated: %q", data)
	}
}

func TestUpdateSkillRespectsExplicitAPIURLAndClassifiesUnsupportedService(t *testing.T) {
	stateDir := t.TempDir()
	store := auth.Store{Dir: stateDir}
	// Persist an official production service in connection.json.
	if err := store.Save(auth.Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: DefaultAPIURL}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	// Explicit MUVLOOM_API_URL pointing at a custom/self-hosted service must NOT fall back to connection.json!
	a := &App{
		APIURL: "https://self-hosted.example.com",
		Store:  store,
		Home:   t.TempDir(),
		CWD:    t.TempDir(),
		Out:    &out,
		Err:    io.Discard,
	}
	code := a.Run([]string{"--json", "update", "skill", "--check"})
	if code != ExitRejected {
		t.Fatalf("expected ExitRejected (CAPABILITY_UNAVAILABLE), got %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), `"code":"CAPABILITY_UNAVAILABLE"`) {
		t.Fatalf("unexpected error envelope: %s", out.String())
	}
}

func TestUpdateSelfCommandAndAuthStatusAutoSelfUpdate(t *testing.T) {
	binDir := t.TempDir()
	stateDir := t.TempDir()
	exe := filepath.Join(binDir, "muvloom")
	if err := os.WriteFile(exe, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	nextCLIVer := "99.0.0"
	newBinary := []byte("upgraded-muvloom-99.0.0")
	binSum := sha256.Sum256(newBinary)
	platform := runtime.GOOS + "/" + runtime.GOARCH

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	w, _ := zw.Create("muvloom/SKILL.md")
	skillContent := []byte("---\nname: muvloom\ndescription: Test\n---\n# Test\n")
	_, _ = w.Write(skillContent)
	_ = zw.Close()
	zipBytes := zipBuf.Bytes()
	zipSum := sha256.Sum256(zipBytes)
	fileSum := sha256.Sum256(skillContent)
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00", "SKILL.md", len(skillContent))
	h.Write(skillContent)
	treeHash := hex.EncodeToString(h.Sum(nil))

	manifest := skill.RemoteManifest{
		SchemaVersion: 1,
		Skill:         "muvloom",
		Version:       skill.SkillVersion,
		BundleVersion: nextCLIVer,
		Packages: map[string]skill.RemoteManifestBundle{
			"workbuddy": {
				Archive:       "muvloom-workbuddy.zip",
				ArchiveSHA256: hex.EncodeToString(zipSum[:]),
				FileHash:      treeHash,
				Files:         []skill.RemoteManifestFile{{Path: "SKILL.md", Bytes: len(skillContent), SHA256: hex.EncodeToString(fileSum[:])}},
			},
		},
		CLI: &skill.RemoteManifestCLI{
			Version: nextCLIVer,
			Binaries: map[string]skill.RemoteManifestBinary{
				platform: {
					Path:   "bin/v" + nextCLIVer + "/muvloom",
					Bytes:  len(newBinary),
					SHA256: hex.EncodeToString(binSum[:]),
				},
			},
		},
	}
	manifestBytes, _ := json.Marshal(manifest)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cli/skill-manifest.json":
			_, _ = w.Write(manifestBytes)
		case "/cli/bin/v" + nextCLIVer + "/muvloom":
			_, _ = w.Write(newBinary)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	var out bytes.Buffer
	a := &App{
		APIURL:          DefaultAPIURL,
		Store:           auth.Store{Dir: stateDir},
		Home:            t.TempDir(),
		CWD:             t.TempDir(),
		ExecutablePath:  exe,
		ManifestBaseURL: srv.URL,
		HTTP:            srv.Client(),
		Out:             &out,
		Err:             io.Discard,
	}

	// 1. Flag validation and --auto off.
	if code := a.Run([]string{"--json", "update", "self", "--check", "--auto", "off"}); code != ExitInvalid {
		t.Fatalf("expected ExitInvalid, got %d", code)
	}
	out.Reset()
	if code := a.Run([]string{"--json", "update", "self", "--auto", "off"}); code != ExitOK || updates.SelfAutoUpdateEnabled(stateDir) {
		t.Fatalf("--auto off failed: %d %s", code, out.String())
	}

	// 2. --check reports update_available without modifying binary.
	out.Reset()
	if code := a.Run([]string{"--json", "update", "self", "--check"}); code != ExitOK || !strings.Contains(out.String(), `"status":"update_available"`) {
		t.Fatalf("update self --check failed: %d %s", code, out.String())
	}
	if got, _ := os.ReadFile(exe); string(got) != "old-binary" {
		t.Fatalf("--check modified binary: %q", got)
	}

	// 3. Re-enable --auto on, then `auth status` silently upgrades binary on disk and reports 99.0.0.
	out.Reset()
	if code := a.Run([]string{"--json", "update", "self", "--auto", "on"}); code != ExitOK {
		t.Fatalf("--auto on failed: %d", code)
	}
	out.Reset()
	if code := a.Run([]string{"--json", "auth", "status"}); code != ExitOK {
		t.Fatalf("auth status failed: %d %s", code, out.String())
	}
	if !strings.Contains(out.String(), `"cli_version":"`+Version+`"`) || !strings.Contains(out.String(), `"cli_updated_to":"99.0.0"`) {
		t.Fatalf("auth status did not report silent CLI upgrade: %s", out.String())
	}
	if got, _ := os.ReadFile(exe); !bytes.Equal(got, newBinary) {
		t.Fatalf("auth status did not replace binary: %q", got)
	}
}
