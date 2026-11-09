package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func TestSkillInstallIntoADirectoryIsFoundByStatus(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	dir := filepath.Join(app.Home, ".somehost", "skills")
	r := execute(t, app, "skill", "install", "--dir", dir)
	if r.code != ExitOK {
		t.Fatalf("--dir install = %d %s", r.code, r.stdout)
	}
	data, _ := r.out["data"].(map[string]any)
	path := filepath.Join(dir, "muvloom")
	if data["host"] != "custom" || data["scope"] != "dir" || data["dir"] != dir || data["path"] != path {
		t.Fatalf("unexpected result: %v", data)
	}
	if _, err := os.Stat(filepath.Join(path, "SKILL.md")); err != nil {
		t.Fatalf("SKILL.md not installed: %v", err)
	}
	r = execute(t, app, "skill", "status")
	data, _ = r.out["data"].(map[string]any)
	installed, _ := data["installed"].([]any)
	if r.code != ExitOK || len(installed) != 1 {
		t.Fatalf("status = %d %s", r.code, r.stdout)
	}
	item, _ := installed[0].(map[string]any)
	if item["path"] != path || item["managed"] != true || item["current"] != true ||
		item["version"] != skill.BundleVersion || item["skills_dir"] != dir {
		t.Fatalf("status did not recognise the directory install: %v", item)
	}
}

// An older copy in a recorded directory follows the CLI, and `auth status` says so where it
// cannot: with a stable reason word and the command that puts it right.
func TestAuthStatusRefreshesARecordedDirectoryInstall(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	dir := filepath.Join(app.Home, ".somehost", "skills")
	if r := execute(t, app, "skill", "install", "--dir", dir); r.code != ExitOK {
		t.Fatalf("--dir install = %d %s", r.code, r.stdout)
	}
	path := filepath.Join(dir, "muvloom")
	metaPath := filepath.Join(path, ".muvloom-skill.json")
	// An older release of the same files: only the version its metadata records changes, so
	// the copy stays unedited and is the one the refresh is meant to replace.
	meta, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	older := strings.Replace(string(meta), `"version": "`+skill.BundleVersion+`"`, `"version": "0.1.1"`, 1)
	if older == string(meta) {
		t.Fatalf("metadata does not record the bundled version: %s", meta)
	}
	if err := os.WriteFile(metaPath, []byte(older), 0o644); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "skill", "status")
	data, _ := r.out["data"].(map[string]any)
	installed, _ := data["installed"].([]any)
	item, _ := installed[0].(map[string]any)
	if item["version"] != "0.1.1" || item["intact"] != true {
		t.Fatalf("status before the refresh: %v", item)
	}
	if r := execute(t, app, "auth", "status"); r.code != ExitOK {
		t.Fatalf("auth status = %d %s", r.code, r.stdout)
	}
	if refreshed, _ := os.ReadFile(metaPath); !strings.Contains(string(refreshed), `"version": "`+skill.BundleVersion+`"`) {
		t.Fatalf("the recorded directory install was not refreshed: %s", refreshed)
	}
	r = execute(t, app, "skill", "status")
	data, _ = r.out["data"].(map[string]any)
	installed, _ = data["installed"].([]any)
	item, _ = installed[0].(map[string]any)
	if item["version"] != skill.BundleVersion || item["current"] != true {
		t.Fatalf("status after the refresh: %v", item)
	}
	// An edited copy is left alone and named, with the command for this directory.
	body := filepath.Join(path, "SKILL.md")
	if err := os.WriteFile(body, []byte("my notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = execute(t, app, "auth", "status")
	if !strings.Contains(r.stderr, "muvloom skill install --dir "+dir) {
		t.Fatalf("stderr did not name the directory: %q", r.stderr)
	}
	if read, _ := os.ReadFile(body); string(read) != "my notes" {
		t.Fatal("an edited copy was replaced")
	}
}

func TestSkillInstallRejectsDirWithHostOrScope(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	dir := filepath.Join(app.Home, ".somehost", "skills")
	for _, args := range [][]string{
		{"skill", "install", "--dir", dir, "--host", "codex"},
		{"skill", "install", "--dir", dir, "--scope", "user"},
		{"skill", "install"},
		{"skill", "install", "--dir", app.Home},
	} {
		if r := execute(t, app, args...); r.code != ExitInvalid {
			t.Fatalf("%v = %d %s", args, r.code, r.stdout)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "muvloom")); err == nil {
		t.Fatal("a rejected command installed the Skill")
	}
}
