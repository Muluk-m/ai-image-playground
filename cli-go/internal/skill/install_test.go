package skill

import (
	"encoding/json"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInstallUserHostsAndMetadata(t *testing.T) {
	for _, host := range SupportedHosts() {
		home := t.TempDir()
		result, err := Install(InstallOptions{Host: host, Scope: "user", Home: home})
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		dirName, ok := HostDir(host)
		if !ok {
			t.Fatalf("missing hostDir for %s", host)
		}
		root := filepath.Join(home, filepath.FromSlash(dirName), "skills", "muvloom")
		if result.Path != root || result.Version != SkillVersion || result.FileHash == "" {
			t.Fatalf("unexpected result: %+v", result)
		}
		wantFiles := []string{"SKILL.md", "scripts/muvloom", "scripts/muvloom.ps1", "scripts/muvloom.cmd", "references/cli.md", "references/install.md", "references/jobs.md", "references/errors.md", "references/getting-started.md", "references/image-sets.md", "references/animation.md", ".muvloom-skill.json"}
		if host == "workbuddy" {
			wantFiles = append(wantFiles, "references/workbuddy.md")
		} else {
			wantFiles = append(wantFiles, "agents/openai.yaml")
		}
		for _, name := range wantFiles {
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(name)))
			if err != nil {
				t.Fatalf("%s missing %s: %v", host, name, err)
			}
			if name == "scripts/muvloom" && filepath.Separator == '/' && info.Mode()&0o111 == 0 {
				t.Fatalf("%s scripts/muvloom is not executable: %v", host, info.Mode())
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
		if meta.Version != SkillVersion || meta.Host != host || meta.Scope != "user" || meta.FileHash != result.FileHash {
			t.Fatalf("unexpected metadata: %+v", meta)
		}
	}
}

func TestInstallAutoPrefersCallingAgentEnvOrExistingHostDirs(t *testing.T) {
	// 1. Inside WorkBuddy (env detected): installs ONLY into workbuddy even if ~/.cursor exists.
	home1 := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home1, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	res1, err := InstallAuto(InstallOptions{Scope: "user", Home: home1}, func(k string) string {
		if k == "WORKBUDDY_SANDBOX" {
			return "1"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res1.Installed) != 1 || res1.Host != "workbuddy" {
		t.Fatalf("expected only workbuddy under WORKBUDDY_SANDBOX, got %+v", res1)
	}
	if _, err := os.Stat(filepath.Join(home1, ".cursor", "skills", "muvloom")); !os.IsNotExist(err) {
		t.Fatal("sandboxed auto install touched another host's directory")
	}

	// 2. Plain terminal (no agent env): installs into existing host config directories.
	home2 := t.TempDir()
	for _, d := range []string{".cursor", ".codeium/windsurf"} {
		if err := os.MkdirAll(filepath.Join(home2, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	res2, err := InstallAuto(InstallOptions{Scope: "user", Home: home2}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if len(res2.Installed) != 2 || res2.Installed[0].Host != "cursor" || res2.Installed[1].Host != "windsurf" {
		t.Fatalf("unexpected directory-detected hosts: %+v", res2)
	}

	// 3. Brand-new machine (no agent env and no host dirs yet): installs core defaults.
	home3 := t.TempDir()
	res3, err := InstallAuto(InstallOptions{Scope: "user", Home: home3}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if len(res3.Installed) != 3 {
		t.Fatalf("expected 3 core default hosts on clean machine, got %+v", res3)
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
	realProject, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(realProject, ".agents", "skills", "muvloom")
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

func TestInstallGenericWritesALocalMuvloomDirectory(t *testing.T) {
	cwd := t.TempDir()
	out := filepath.Join(t.TempDir(), "pack")
	result, err := Install(InstallOptions{Host: "generic", Output: out, CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(out, "muvloom")
	if result.Path != want || result.Host != "generic" {
		t.Fatalf("result = %+v, want path %s", result, want)
	}
	if _, err := os.Stat(filepath.Join(want, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	// The default output is cwd/muvloom, never a host directory.
	fallback, err := Install(InstallOptions{Host: "generic", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if fallback.Path != filepath.Join(cwd, "muvloom") {
		t.Fatalf("default generic path = %s", fallback.Path)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".claude")); !os.IsNotExist(err) {
		t.Fatalf("generic install wrote a host directory: %v", err)
	}
}

func TestInstallGenericDoesNotReplaceADirectoryNamedMuvloom(t *testing.T) {
	parent := t.TempDir()
	named := filepath.Join(parent, "muvloom")
	if err := os.MkdirAll(named, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(named, ".git")
	if err := os.WriteFile(marker, []byte("repo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Install(InstallOptions{Host: "generic", CWD: named, Output: named})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(named, "muvloom")
	if result.Path != want {
		t.Fatalf("path = %s, want %s", result.Path, want)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "repo\n" {
		t.Fatalf("project files were changed: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(want, "SKILL.md")); err != nil {
		t.Fatal(err)
	}

	cwdOnly := filepath.Join(t.TempDir(), "muvloom")
	if err := os.MkdirAll(cwdOnly, 0o755); err != nil {
		t.Fatal(err)
	}
	cwdMarker := filepath.Join(cwdOnly, "README")
	if err := os.WriteFile(cwdMarker, []byte("ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cwdResult, err := Install(InstallOptions{Host: "generic", CWD: cwdOnly})
	if err != nil {
		t.Fatal(err)
	}
	if cwdResult.Path != filepath.Join(cwdOnly, "muvloom") {
		t.Fatalf("cwd path = %s, want %s/muvloom", cwdResult.Path, cwdOnly)
	}
	if data, err := os.ReadFile(cwdMarker); err != nil || string(data) != "ok\n" {
		t.Fatalf("cwd project files were changed: %q %v", data, err)
	}
}

func TestInstallGenericRefusesANonSkillMuvloomDirectory(t *testing.T) {
	cwd := t.TempDir()
	existing := filepath.Join(cwd, "muvloom")
	if err := os.MkdirAll(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(existing, "notes.txt")
	if err := os.WriteFile(marker, []byte("keep me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "generic", CWD: cwd}); err == nil {
		t.Fatal("expected error for a non-skill muvloom directory")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep me\n" {
		t.Fatalf("existing files were changed: %q %v", data, err)
	}
}

func TestInstallGenericAcceptsAnEmptyMuvloomDirectory(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "muvloom"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := Install(InstallOptions{Host: "generic", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != filepath.Join(cwd, "muvloom") {
		t.Fatalf("path = %s", result.Path)
	}
	if _, err := os.Stat(filepath.Join(result.Path, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

func TestInstallGenericReplacesAnExistingSkillDirectory(t *testing.T) {
	cwd := t.TempDir()
	first, err := Install(InstallOptions{Host: "generic", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Install(InstallOptions{Host: "generic", CWD: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if second.Path != first.Path {
		t.Fatalf("path changed: %s vs %s", second.Path, first.Path)
	}
	if _, err := os.Stat(filepath.Join(second.Path, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

func TestInstallRefusesToReplaceANonSkillHostDestination(t *testing.T) {
	home := t.TempDir()
	dest := filepath.Join(home, ".claude", "skills", "muvloom")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dest, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home}); err == nil {
		t.Fatal("expected error for a non-skill host destination")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep\n" {
		t.Fatalf("existing files were changed: %q %v", data, err)
	}
}

func TestInstallStillRejectsDoubaoHost(t *testing.T) {
	if _, err := Install(InstallOptions{Host: "doubao", Scope: "user"}); err == nil {
		t.Fatal("expected error for host doubao")
	}
}

func TestRefreshOutdatedUpgradesWorkbuddyInstallWithMetadata(t *testing.T) {
	home, cwd := t.TempDir(), t.TempDir()
	res, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	fakeRelease(t, res.Path, "0.2.0", "workbuddy", "user")
	installed, failed, err := RefreshOutdated(home, cwd)
	if err != nil || len(failed) != 0 {
		t.Fatalf("refresh workbuddy: %v %v", failed, err)
	}
	if len(installed) != 1 || installed[0].Host != "workbuddy" || !installed[0].Current || installed[0].Version != SkillVersion {
		t.Fatalf("workbuddy was not upgraded: %+v", installed)
	}
	// WorkBuddy-specific instructions, metadata, and reference must survive the upgrade.
	if _, err := os.Stat(filepath.Join(res.Path, "references", "workbuddy.md")); err != nil {
		t.Fatalf("workbuddy.md missing after refresh: %v", err)
	}
	skillBytes, _ := os.ReadFile(filepath.Join(res.Path, "SKILL.md"))
	if !strings.Contains(string(skillBytes), "## WorkBuddy") || !strings.Contains(string(skillBytes), "display_name: 幕芽 Muvloom") {
		t.Fatalf("WorkBuddy section or metadata missing after refresh")
	}
}

func TestLegacyWorkbuddyZipIsNotSilentlyOverwrittenButCanBeExplicitlyUpgraded(t *testing.T) {
	home, cwd := t.TempDir(), t.TempDir()
	dest := filepath.Join(home, ".workbuddy", "skills", "muvloom")
	if err := os.MkdirAll(filepath.Join(dest, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := "---\r\nname: muvloom\r\ndescription: Old custom edit\r\nauthor: Muvloom\r\nversion: 1.0.0\r\n---\r\n\r\n# My Custom Notes\r\n"
	if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "references", "my-notes.md"), []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	// RefreshOutdated must NOT silently overwrite an unhashed legacy directory.
	installed, failed, err := RefreshOutdated(home, cwd)
	if err != nil || len(failed) != 0 {
		t.Fatalf("refresh legacy workbuddy: %v %v", failed, err)
	}
	if len(installed) != 1 || installed[0].Host != "workbuddy" || installed[0].Intact || installed[0].Current {
		t.Fatalf("expected unverified legacy workbuddy to report Intact=false: %+v", installed)
	}
	if data, _ := os.ReadFile(filepath.Join(dest, "SKILL.md")); string(data) != legacy {
		t.Fatal("RefreshOutdated silently overwrote unhashed legacy SKILL.md")
	}
	if data, _ := os.ReadFile(filepath.Join(dest, "references", "my-notes.md")); string(data) != "keep me" {
		t.Fatal("RefreshOutdated deleted user markdown file in legacy dir")
	}
	// Explicit install upgrades the legacy WorkBuddy directory and writes .muvloom-skill.json.
	if _, err := Install(InstallOptions{Host: "workbuddy", Scope: "user", Home: home}); err != nil {
		t.Fatalf("explicit workbuddy install failed: %v", err)
	}
	after, err := Installed(home, cwd)
	if err != nil || len(after) != 1 || !after[0].Intact || !after[0].Current || after[0].Version != SkillVersion {
		t.Fatalf("after explicit install = %+v, %v", after, err)
	}
}

func TestClaudeAndCodexFrontmatterSatisfiesAgentSkillsSpec(t *testing.T) {
	for _, host := range []string{"claude-code", "codex"} {
		files, _, err := bundleFilesForHost(host)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if f.path != "SKILL.md" {
				continue
			}
			text := string(f.data)
			end := strings.Index(text[4:], "\n---\n")
			if end < 0 {
				t.Fatalf("%s SKILL.md missing frontmatter", host)
			}
			fm := text[4 : 4+end]
			for _, forbidden := range []string{"display_name:", "display_name_en:", "description_zh:", "description_en:", "version:", "author:"} {
				if strings.Contains(fm, forbidden) {
					t.Fatalf("%s SKILL.md contains non-spec frontmatter key %s", host, forbidden)
				}
			}
		}
	}
}

func TestRefreshOutdatedSkipsCustomizedOrProjectOrSymlinkLegacyWorkbuddy(t *testing.T) {
	t.Run("custom file in user workbuddy dir", func(t *testing.T) {
		home, cwd := t.TempDir(), t.TempDir()
		dest := filepath.Join(home, ".workbuddy", "skills", "muvloom")
		if err := os.MkdirAll(dest, 0o755); err != nil {
			t.Fatal(err)
		}
		legacy := "---\nname: muvloom\nauthor: Muvloom\n---\n# Custom\n"
		if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(legacy), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dest, "my-notes.txt"), []byte("keep"), 0o644); err != nil {
			t.Fatal(err)
		}
		installed, failed, err := RefreshOutdated(home, cwd)
		if err != nil || len(failed) != 0 || len(installed) != 0 {
			t.Fatalf("customized legacy dir should be untouched: %+v %v %v", installed, failed, err)
		}
		if data, _ := os.ReadFile(filepath.Join(dest, "my-notes.txt")); string(data) != "keep" {
			t.Fatal("user file was lost")
		}
	})

	t.Run("project scope workbuddy dir is never auto-overwritten", func(t *testing.T) {
		home := t.TempDir()
		project := filepath.Join(home, "repo")
		dest := filepath.Join(project, ".workbuddy", "skills", "muvloom")
		if err := os.MkdirAll(dest, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte("module example\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		legacy := "---\nname: muvloom\nauthor: Muvloom\n---\n# Project copy\n"
		if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(legacy), 0o644); err != nil {
			t.Fatal(err)
		}
		installed, failed, err := RefreshOutdated(home, project)
		if err != nil || len(failed) != 0 || len(installed) != 0 {
			t.Fatalf("project legacy dir should not be detected: %+v %v %v", installed, failed, err)
		}
		if data, _ := os.ReadFile(filepath.Join(dest, "SKILL.md")); string(data) != legacy {
			t.Fatal("project SKILL.md was modified")
		}
	})

	t.Run("symlink SKILL.md is rejected", func(t *testing.T) {
		home, cwd := t.TempDir(), t.TempDir()
		outside := filepath.Join(t.TempDir(), "SKILL.md")
		if err := os.WriteFile(outside, []byte("---\nname: muvloom\nauthor: Muvloom\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(home, ".workbuddy", "skills", "muvloom")
		if err := os.MkdirAll(dest, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(dest, "SKILL.md")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		installed, failed, err := RefreshOutdated(home, cwd)
		if err != nil || len(failed) != 0 || len(installed) != 0 {
			t.Fatalf("symlink SKILL.md should be rejected: %+v %v %v", installed, failed, err)
		}
	})
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
	if installed[0].Version != SkillVersion || installed[1].Version != SkillVersion {
		t.Fatalf("unexpected versions: %+v", installed)
	}
}

func TestProjectInstallRefusesSymlinkedSkillDirectories(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	outside := t.TempDir()
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte("module example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, ".agents")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Install(InstallOptions{Host: "codex", Scope: "project", Home: home, CWD: project}); err == nil {
		t.Fatal("install followed a symlinked .agents directory")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote outside the project: %v", entries)
	}
}

func TestStatusDetectsEditedInstall(t *testing.T) {
	home := t.TempDir()
	result, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	installed, err := Installed(home, t.TempDir())
	if err != nil || len(installed) != 1 || !installed[0].Intact || !installed[0].Current {
		t.Fatalf("fresh install = %+v, %v", installed, err)
	}
	if err := os.WriteFile(filepath.Join(result.Path, "SKILL.md"), []byte("edited"), 0o644); err != nil {
		t.Fatal(err)
	}
	installed, _ = Installed(home, t.TempDir())
	if installed[0].Intact || installed[0].Current {
		t.Fatalf("edited install reported intact: %+v", installed[0])
	}
}

// An older copy nobody edited follows the CLI; a hand-edited one is left alone.
func TestRefreshOutdatedReplacesOnlyUneditedOldCopies(t *testing.T) {
	home, cwd := t.TempDir(), t.TempDir()
	old, err := Install(InstallOptions{Host: "codex", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	edited, err := Install(InstallOptions{Host: "claude-code", Scope: "user", Home: home})
	if err != nil {
		t.Fatal(err)
	}
	// An older release: different files, metadata that matches them.
	if err := os.WriteFile(filepath.Join(old.Path, "SKILL.md"), []byte("old release"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := treeHash(old.Path)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := json.Marshal(metadata{Skill: "muvloom", Version: "0.1.1", Host: "codex", Scope: "user", FileHash: hash})
	if err := os.WriteFile(filepath.Join(old.Path, ".muvloom-skill.json"), meta, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(edited.Path, "SKILL.md"), []byte("my notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, failed, err := RefreshOutdated(home, cwd)
	if err != nil || len(failed) != 0 {
		t.Fatalf("refresh: %v %v", failed, err)
	}
	installed, _ := Installed(home, cwd)
	for _, item := range installed {
		switch item.Host {
		case "codex":
			if !item.Current || item.Version != SkillVersion {
				t.Fatalf("old copy not refreshed: %+v", item)
			}
		case "claude-code":
			if item.Intact {
				t.Fatalf("edited copy was replaced: %+v", item)
			}
		}
	}
	if data, _ := os.ReadFile(filepath.Join(edited.Path, "SKILL.md")); string(data) != "my notes" {
		t.Fatal("edited copy lost its changes")
	}
}

// fakeRelease makes an installed copy look like another release: other files, matching metadata.
func fakeRelease(t *testing.T, path, version, host, scope string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte("release "+version), 0o644); err != nil {
		t.Fatal(err)
	}
	hash, err := treeHash(path)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := json.Marshal(metadata{Skill: "muvloom", Version: version, Host: host, Scope: scope, FileHash: hash})
	if err := os.WriteFile(filepath.Join(path, ".muvloom-skill.json"), meta, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRefreshOutdatedNeverDowngradesMovesOrRacesACopy(t *testing.T) {
	cwd := t.TempDir()
	t.Run("newer copy", func(t *testing.T) {
		home := t.TempDir()
		result, _ := Install(InstallOptions{Host: "codex", Scope: "user", Home: home})
		fakeRelease(t, result.Path, "9.9.9", "codex", "user")
		if _, failed, err := RefreshOutdated(home, cwd); err != nil || len(failed) != 0 {
			t.Fatal(failed, err)
		}
		if data, _ := os.ReadFile(filepath.Join(result.Path, "SKILL.md")); string(data) != "release 9.9.9" {
			t.Fatal("a newer copy was downgraded")
		}
	})
	t.Run("metadata from elsewhere", func(t *testing.T) {
		home := t.TempDir()
		result, _ := Install(InstallOptions{Host: "codex", Scope: "user", Home: home})
		fakeRelease(t, result.Path, "0.0.1", "codex", "project")
		if _, failed, err := RefreshOutdated(home, cwd); err != nil || len(failed) != 0 {
			t.Fatal(failed, err)
		}
		if data, _ := os.ReadFile(filepath.Join(result.Path, "SKILL.md")); string(data) != "release 0.0.1" {
			t.Fatal("a copy placed by hand was refreshed")
		}
	})
	t.Run("edited while waiting for the lock", func(t *testing.T) {
		home := t.TempDir()
		result, _ := Install(InstallOptions{Host: "codex", Scope: "user", Home: home})
		fakeRelease(t, result.Path, "0.0.1", "codex", "user")
		// Another process holds the install lock and edits the copy before letting go.
		release, err := auth.LockFile(filepath.Join(filepath.Dir(result.Path), ".muvloom-install.lock"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			time.Sleep(200 * time.Millisecond)
			_ = os.WriteFile(filepath.Join(result.Path, "SKILL.md"), []byte("edited meanwhile"), 0o644)
			release()
		}()
		if _, failed, err := RefreshOutdated(home, cwd); err != nil || len(failed) != 0 {
			t.Fatal(failed, err)
		}
		if data, _ := os.ReadFile(filepath.Join(result.Path, "SKILL.md")); string(data) != "edited meanwhile" {
			t.Fatal("an edit made while waiting for the lock was overwritten")
		}
	})
}
