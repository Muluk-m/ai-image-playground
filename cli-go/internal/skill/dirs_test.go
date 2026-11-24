package skill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain keeps every test off the developer's real --dir registry.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "muvloom-skill-config-")
	if err != nil {
		panic(err)
	}
	os.Setenv("MUVLOOM_CONFIG_DIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestDirInstallIsRegisteredReportedAndRefreshed(t *testing.T) {
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	home, cwd, skills := t.TempDir(), t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Dir: skills, Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != filepath.Join(skills, "muvloom") || res.Host != customHost {
		t.Fatalf("dir install = %+v", res)
	}
	installed, err := Installed(home, cwd)
	if err != nil || len(installed) != 1 || installed[0].Path != res.Path || !installed[0].Current {
		t.Fatalf("status after --dir install = %+v %v", installed, err)
	}

	fakeRelease(t, res.Path, "0.1.0", customHost, customScope)
	installed, _ = Installed(home, cwd)
	if installed[0].Current || !installed[0].Intact {
		t.Fatalf("an older unedited copy must be reported outdated: %+v", installed)
	}
	installed, failed, err := RefreshOutdated(home, cwd)
	if err != nil || len(failed) != 0 {
		t.Fatalf("refresh: %v %v", failed, err)
	}
	if len(installed) != 1 || !installed[0].Current || installed[0].Version != SkillVersion {
		t.Fatalf("--dir copy was not refreshed: %+v", installed)
	}

	// Installing the same directory again does not register it twice.
	if _, err := Install(InstallOptions{Dir: skills, Home: home}); err != nil {
		t.Fatal(err)
	}
	if dirs := RegisteredDirs(); len(dirs) != 1 {
		t.Fatalf("registry = %v", dirs)
	}
}

func TestRegisteredDirThatWasRemovedIsSkipped(t *testing.T) {
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	home, skills := t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Dir: skills, Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(res.Path); err != nil {
		t.Fatal(err)
	}
	installed, err := Installed(home, t.TempDir())
	if err != nil || len(installed) != 0 {
		t.Fatalf("a removed --dir copy must be skipped: %+v %v", installed, err)
	}
}

func TestContentIsTheBundledSkillAndItsReferences(t *testing.T) {
	content, err := Content()
	if err != nil {
		t.Fatal(err)
	}
	files, _, err := bundleFilesForHost("")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		included := strings.Contains(content, string(f.data))
		instructions := f.path == "SKILL.md" || strings.HasPrefix(f.path, "references/")
		if instructions != included {
			t.Fatalf("%s included = %v, want %v", f.path, included, instructions)
		}
	}
	if strings.Contains(content, "references/workbuddy.md") {
		t.Fatal("host-specific WorkBuddy notes do not belong in the generic text")
	}
}
