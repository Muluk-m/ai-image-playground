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
	"strings"
	"testing"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

type updateTransport func(*http.Request) (*http.Response, error)

func (f updateTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestUpdateCommandWorksWithoutLoginAndCachesItsResult(t *testing.T) {
	var out bytes.Buffer
	calls := 0
	a := &App{APIURL: DefaultAPIURL, Store: auth.Store{Dir: t.TempDir()}, Out: &out, Err: io.Discard}
	a.HTTP = &http.Client{Transport: updateTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "api.github.com" || req.Header.Get("Authorization") != "" {
			t.Fatalf("update used an account API or credential")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`[{"tag_name":"cli-v%s"}]`, Version)))}, nil
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
			} `json:"data"`
		}
		if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.OK || result.Data.Status != "up_to_date" || result.Data.Cached != (attempt == 1) || result.Data.ShouldPrompt || result.Data.InstallDirectory == "" {
			t.Fatalf("bad command response: %s", out.String())
		}
	}
	if calls != 1 {
		t.Fatalf("check re-fetched %d times", calls)
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
