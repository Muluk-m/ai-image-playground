package skill

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInstallUserHostsAndMetadata(t *testing.T) {
	for _, host := range []string{"claude-code", "codex"} {
		home := t.TempDir()
		result, err := Install(InstallOptions{Host: host, Scope: "user", Home: home})
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		dirName := ".claude"
		if host == "codex" {
			dirName = ".agents"
		}
		root := filepath.Join(home, dirName, "skills", "muvloom")
		if result.Path != root || result.Version != BundleVersion || result.FileHash == "" {
			t.Fatalf("unexpected result: %+v", result)
		}
		for _, name := range []string{"SKILL.md", "agents/openai.yaml", "references/cli.md", "references/install.md", "references/jobs.md", "references/errors.md", ".muvloom-skill.json"} {
			if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(name))); err != nil {
				t.Fatalf("%s missing %s: %v", host, name, err)
			}
		}
		var meta metadata
		data, err := os.ReadFile(filepath.Join(root, ".muvloom-skill.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &meta); err != nil {
			t.Fatal(err)
		}
		if meta.Version != BundleVersion || meta.Host != host || meta.Scope != "user" || meta.FileHash != result.FileHash {
			t.Fatalf("unexpected metadata: %+v", meta)
		}
	}
}

func TestInstallProjectFindsRootAndReplacesDeterministically(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	nested := filepath.Join(project, "src", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte("module example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := Install(InstallOptions{Host: "codex", Scope: "project", Home: home, CWD: nested})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Install(InstallOptions{Host: "codex", Scope: "project", Home: home, CWD: nested})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(project, ".agents", "skills", "muvloom")
	if first.Path != want || second.Path != want || first.FileHash != second.FileHash {
		t.Fatalf("unexpected project result: %+v %+v", first, second)
	}
}

func TestInstallRejectsUnknownHostAndScope(t *testing.T) {
	for _, opts := range []InstallOptions{{Host: "other", Scope: "user"}, {Host: "codex", Scope: "global"}} {
		if _, err := Install(opts); err == nil {
			t.Fatalf("expected error for %+v", opts)
		}
	}
}

func TestInstalledReportsUserAndProjectMetadata(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	nested := filepath.Join(project, "src")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte("module example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "codex", Scope: "project", Home: home, CWD: nested}); err != nil {
		t.Fatal(err)
	}
	installed, err := Installed(home, nested)
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != 2 {
		t.Fatalf("got %d installations: %+v", len(installed), installed)
	}
	if installed[0].Version != BundleVersion || installed[1].Version != BundleVersion {
		t.Fatalf("unexpected versions: %+v", installed)
	}
}
