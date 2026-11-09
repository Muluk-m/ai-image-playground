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

// A host that cannot install Skills reads the body from stdout: it must be the embedded
// Skill byte for byte, with nothing added.
func TestSkillPrintWritesTheEmbeddedSkillByteForByte(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	for _, name := range []string{"SKILL.md", "references/cli.md", "references/install.md"} {
		want, err := skill.Body(name)
		if err != nil {
			t.Fatal(err)
		}
		args := []string{"skill", "print"}
		if name != "SKILL.md" {
			args = append(args, "--file", name)
		}
		stdout, _, code := runText(t, app, args...)
		if code != ExitOK {
			t.Fatalf("%v = %d", args, code)
		}
		if stdout != string(want) {
			t.Fatalf("%s: stdout is not the embedded file (%d vs %d bytes)", name, len(stdout), len(want))
		}
	}
	// `--json` carries the same bytes, so a host can read them from the envelope instead.
	r := execute(t, app, "skill", "print")
	data, _ := r.out["data"].(map[string]any)
	want, _ := skill.Body("SKILL.md")
	if r.code != ExitOK || data["content"] != string(want) || data["version"] != skill.BundleVersion {
		t.Fatalf("skill print --json = %d %v", r.code, data)
	}
	// The files a host may ask for are listed, and nothing outside the bundle is served.
	r = execute(t, app, "skill", "print", "--list")
	data, _ = r.out["data"].(map[string]any)
	files, _ := data["files"].([]any)
	if r.code != ExitOK || len(files) == 0 || files[0] != "SKILL.md" {
		t.Fatalf("skill print --list = %d %v", r.code, data)
	}
	if r := execute(t, app, "skill", "print", "--file", "../../../etc/passwd"); r.code != ExitInvalid {
		t.Fatalf("a path outside the bundle = %d %s", r.code, r.stdout)
	}
}

func TestHelpListsTheSkillCommands(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	stdout, _, _ := runText(t, app, "--help")
	for _, want := range []string{"skill install", "skill status", "skill print"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("main help is missing %q", want)
		}
	}
	stdout, _, _ = runText(t, app, "skill", "install", "--help")
	for _, want := range []string{"--dir DIRECTORY", "<dir>/muvloom"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("skill install help is missing %q: %s", want, stdout)
		}
	}
	stdout, _, _ = runText(t, app, "skill", "print", "--help")
	if !strings.Contains(stdout, "--file PATH") || !strings.Contains(stdout, "--list") {
		t.Fatalf("skill print help: %s", stdout)
	}
}
