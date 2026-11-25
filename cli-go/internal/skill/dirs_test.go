package skill

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestDirInstallIntoAHostSkillsDirectoryStaysThatHostsInstall(t *testing.T) {
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	home := t.TempDir()
	res, err := Install(InstallOptions{Dir: filepath.Join(home, ".claude", "skills"), Home: home})
	if err != nil {
		t.Fatal(err)
	}
	if res.Host != "claude-code" || res.Scope != "user" {
		t.Fatalf("--dir into ~/.claude/skills = %+v", res)
	}
	if dirs := RegisteredDirs(); len(dirs) != 0 {
		t.Fatalf("a host directory must not be registered as custom: %v", dirs)
	}
	installed, _ := Installed(home, t.TempDir())
	if len(installed) != 1 || installed[0].Host != "claude-code" || !installed[0].Current {
		t.Fatalf("status = %+v", installed)
	}
}

func TestDirInstallIntoAnotherProjectsHostDirectoryIsThatProjectsInstall(t *testing.T) {
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	home, here, other := t.TempDir(), t.TempDir(), t.TempDir()
	for _, root := range []string{here, other} {
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	res, err := Install(InstallOptions{Dir: filepath.Join(other, ".claude", "skills"), Home: home, CWD: here})
	if err != nil {
		t.Fatal(err)
	}
	if res.Host != "claude-code" || res.Scope != "project" {
		t.Fatalf("--dir into another project's .claude/skills = %+v", res)
	}
	if dirs := RegisteredDirs(); len(dirs) != 0 {
		t.Fatalf("a project host directory must not be registered as custom: %v", dirs)
	}
	installed, _ := Installed(home, other)
	if len(installed) != 1 || installed[0].Scope != "project" || !installed[0].Current {
		t.Fatalf("status in that project = %+v", installed)
	}
}

func TestReinstallCommandNamesTheDirectoryForACustomCopy(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "skills")
	custom := Installation{Host: customHost, Scope: customScope, Path: filepath.Join(dir, "muvloom")}
	if got := ReinstallCommand(custom); got != "muvloom skill install --dir "+shellQuote(dir, runtime.GOOS) {
		t.Fatalf("custom = %s", got)
	}
	// Nothing in a directory name may expand when the command is pasted into a shell.
	if got := shellQuote(`/a/$(touch x) $HOME `+"`id`"+` it's`, "linux"); got != `'/a/$(touch x) $HOME `+"`id`"+` it'\''s'` {
		t.Fatalf("posix = %s", got)
	}
	if got := shellQuote(`C:\a\$env:X it's`, "windows"); got != `'C:\a\$env:X it''s'` {
		t.Fatalf("powershell = %s", got)
	}
	if got := ReinstallCommand(Installation{Host: "codex", Scope: "user"}); got != "muvloom skill install --host codex --scope user" {
		t.Fatalf("host = %s", got)
	}
}

func TestDamagedRegistryIsKeptAsideNotOverwritten(t *testing.T) {
	config := t.TempDir()
	t.Setenv("MUVLOOM_CONFIG_DIR", config)
	if err := os.WriteFile(filepath.Join(config, "skill-dirs.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Dir: t.TempDir(), Home: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	kept, _ := filepath.Glob(filepath.Join(config, "skill-dirs.json.bad-*"))
	if len(kept) != 1 {
		t.Fatalf("damaged registry copies = %v", kept)
	}
	if data, err := os.ReadFile(kept[0]); err != nil || string(data) != "{broken" {
		t.Fatalf("damaged registry = %q, %v", data, err)
	}
	if len(RegisteredDirs()) != 1 {
		t.Fatalf("registry = %v", RegisteredDirs())
	}
}

// The web manifest publishes the generic CLI package for --dir copies (dir_package);
// a hot update only lands as intended while both bundles hold the same files.
func TestDirCopiesBundleTheSameFilesAsTheGenericHosts(t *testing.T) {
	_, custom, err := bundleFilesForHost(customHost)
	if err != nil {
		t.Fatal(err)
	}
	_, generic, err := bundleFilesForHost("claude-code")
	if err != nil {
		t.Fatal(err)
	}
	if custom != generic {
		t.Fatalf("custom bundle hash %s != claude-code %s", custom, generic)
	}
}
