package skill

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// hostSkillsDir is a skills directory a host of its own would keep, outside the fixed ones.
func hostSkillsDir(t *testing.T, home string) string {
	t.Helper()
	dir := filepath.Join(home, ".somehost", "skills")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// unmanage turns an installed copy into one its host installed: our metadata gone, the
// frontmatter carrying the host's own version, and a file of the host's own in the tree.
func unmanage(t *testing.T, path, version string) {
	t.Helper()
	if err := os.Remove(filepath.Join(path, metadataFile)); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(path, BodyFile))
	if err != nil {
		t.Fatal(err)
	}
	end := strings.Index(string(body), "\n---\n")
	if end < 0 {
		t.Fatal("the bundled SKILL.md has no frontmatter")
	}
	repacked := string(body[:end]) + "\nversion: " + version + "\nauthor: Some Host\n---\n" + string(body[end+5:])
	if err := os.WriteFile(filepath.Join(path, BodyFile), []byte(repacked), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "references", "somehost.md"), []byte("# Some host\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInstallDirInstallsIntoTheSkillsDirectoryAndRecordsIt(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	dir := hostSkillsDir(t, home)
	result, err := Install(InstallOptions{Dir: dir, Home: home, CWD: cwd, ConfigDir: config})
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != filepath.Join(dir, SkillFolder) || result.Dir != dir ||
		result.Host != HostCustom || result.Scope != ScopeDir || result.Version != BundleVersion {
		t.Fatalf("unexpected result: %+v", result)
	}
	for _, name := range []string{BodyFile, "references/cli.md", metadataFile} {
		if _, err := os.Stat(filepath.Join(result.Path, filepath.FromSlash(name))); err != nil {
			t.Fatalf("%s missing: %v", name, err)
		}
	}
	var meta metadata
	data, err := os.ReadFile(filepath.Join(result.Path, metadataFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Host != HostCustom || meta.Scope != ScopeDir || meta.Version != BundleVersion || meta.FileHash != result.FileHash {
		t.Fatalf("unexpected metadata: %+v", meta)
	}
	// The directory is remembered once, with nothing but its path in the file.
	if _, err := Install(InstallOptions{Dir: dir, Home: home, CWD: cwd, ConfigDir: config}); err != nil {
		t.Fatal(err)
	}
	recorded, err := os.ReadFile(filepath.Join(config, registryFile))
	if err != nil {
		t.Fatal(err)
	}
	var stored registry
	if err := json.Unmarshal(recorded, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.SchemaVersion != 1 || len(stored.Directories) != 1 || stored.Directories[0] != dir {
		t.Fatalf("unexpected registry: %s", recorded)
	}
	if info, err := os.Stat(filepath.Join(config, registryFile)); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("registry mode = %v", info.Mode().Perm())
	}
}

func TestInstallDirRefusesDangerousDirectoriesAndSymlinks(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	dir := hostSkillsDir(t, home)
	for name, value := range map[string]string{
		"empty":            "   ",
		"home":             home,
		"filesystem root":  string(os.PathSeparator),
		"the Skill folder": filepath.Join(dir, SkillFolder),
		"unexpanded tilde": "~/.somehost/skills",
	} {
		if _, err := Install(InstallOptions{Dir: value, Home: home, CWD: cwd, ConfigDir: config}); err == nil {
			t.Fatalf("%s was accepted as --dir", name)
		}
	}
	if _, err := os.Stat(filepath.Join(config, registryFile)); err == nil {
		t.Fatal("a refused install was recorded")
	}
	// A destination that is a symlink is never replaced: the Skill it points at is a copy
	// somebody manages on purpose.
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, SkillFolder)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Install(InstallOptions{Dir: dir, Home: home, CWD: cwd, ConfigDir: config}); err == nil {
		t.Fatal("install replaced a symlinked destination")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote through the symlink: %v", entries)
	}
}

func TestStatusFindsWorkBuddyAndRecordedDirectories(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	workBuddy := workBuddySkillsDir(home)
	if err := os.MkdirAll(workBuddy, 0o755); err != nil {
		t.Fatal(err)
	}
	// WorkBuddy installs its copy itself, from a zip that carries its own version and
	// reference file: this one is found without ever having been recorded by us.
	installed, err := Install(InstallOptions{Dir: workBuddy, Home: home, CWD: cwd, ConfigDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	unmanage(t, installed.Path, "1.0.0")
	recorded := hostSkillsDir(t, home)
	if _, err := Install(InstallOptions{Dir: recorded, Home: home, CWD: cwd, ConfigDir: config}); err != nil {
		t.Fatal(err)
	}
	found, err := Installed(home, cwd, config)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]Installation{}
	for _, item := range found {
		byPath[item.Path] = item
	}
	if len(found) != 2 {
		t.Fatalf("got %d installations: %+v", len(found), found)
	}
	host := byPath[filepath.Join(workBuddy, SkillFolder)]
	if host.Host != HostWorkBuddy || host.Scope != ScopeDir || host.Managed ||
		host.Version != "1.0.0" || host.Intact || host.Current || host.SkillsDir != workBuddy {
		t.Fatalf("WorkBuddy copy = %+v", host)
	}
	ours := byPath[filepath.Join(recorded, SkillFolder)]
	if ours.Host != HostCustom || !ours.Managed || !ours.Intact || !ours.Current ||
		ours.Version != BundleVersion || ours.SkillsDir != recorded {
		t.Fatalf("recorded copy = %+v", ours)
	}
	// Our own files with the metadata removed are still recognised, by their hash alone.
	if err := os.Remove(filepath.Join(ours.Path, metadataFile)); err != nil {
		t.Fatal(err)
	}
	found, err = Installed(home, cwd, config)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range found {
		if item.Path == ours.Path && (item.Managed || !item.Intact || !item.Current || item.Version != BundleVersion) {
			t.Fatalf("copy without metadata = %+v", item)
		}
	}
}

func TestStatusReportsNothingWhereNoSkillIsInstalled(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	// A recorded directory the user emptied, and an empty WorkBuddy directory.
	if err := rememberDir(config, hostSkillsDir(t, home)); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workBuddySkillsDir(home), SkillFolder), 0o755); err != nil {
		t.Fatal(err)
	}
	found, err := Installed(home, cwd, config)
	if err != nil || len(found) != 0 {
		t.Fatalf("Installed = %+v, %v", found, err)
	}
	// A damaged record is as good as none; nothing is written while reading.
	if err := os.WriteFile(filepath.Join(config, registryFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if found, err = Installed(home, cwd, config); err != nil || len(found) != 0 {
		t.Fatalf("Installed with a damaged record = %+v, %v", found, err)
	}
}

func TestRefreshUpdatesRecordedDirectoriesAndLeavesHostCopiesAlone(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	recorded := hostSkillsDir(t, home)
	ours, err := Install(InstallOptions{Dir: recorded, Home: home, CWD: cwd, ConfigDir: config})
	if err != nil {
		t.Fatal(err)
	}
	fakeRelease(t, ours.Path, "0.1.1", HostCustom, ScopeDir)
	// A copy its host installed, of an older release of its own: it cannot be told apart
	// from an edited one, so it stays as it is.
	workBuddy := workBuddySkillsDir(home)
	if err := os.MkdirAll(workBuddy, 0o755); err != nil {
		t.Fatal(err)
	}
	theirs, err := Install(InstallOptions{Dir: workBuddy, Home: home, CWD: cwd, ConfigDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	unmanage(t, theirs.Path, "0.0.1")
	before, err := os.ReadFile(filepath.Join(theirs.Path, BodyFile))
	if err != nil {
		t.Fatal(err)
	}
	found, failed, err := RefreshOutdated(home, cwd, config)
	if err != nil || len(failed) != 0 {
		t.Fatalf("refresh: %v %v", failed, err)
	}
	for _, item := range found {
		switch item.Path {
		case ours.Path:
			if !item.Current || item.Version != BundleVersion || !item.Managed {
				t.Fatalf("recorded copy not refreshed: %+v", item)
			}
		case theirs.Path:
			if item.Managed || item.Current || item.Version != "0.0.1" {
				t.Fatalf("host copy = %+v", item)
			}
		default:
			t.Fatalf("unexpected copy: %+v", item)
		}
	}
	if after, _ := os.ReadFile(filepath.Join(theirs.Path, BodyFile)); string(after) != string(before) {
		t.Fatal("the host's own copy was replaced")
	}
	if _, err := os.Stat(filepath.Join(theirs.Path, "references", "somehost.md")); err != nil {
		t.Fatalf("the host's own reference file was removed: %v", err)
	}
}

// A copy in the WorkBuddy directory that this CLI installed carries our metadata, and then
// follows the CLI like any other copy it installed.
func TestRefreshUpdatesTheWorkBuddyDirectoryOnlyWhenWeInstalledIt(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	workBuddy := workBuddySkillsDir(home)
	if err := os.MkdirAll(workBuddy, 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := Install(InstallOptions{Dir: workBuddy, Home: home, CWD: cwd, ConfigDir: config})
	if err != nil {
		t.Fatal(err)
	}
	fakeRelease(t, result.Path, "0.2.0", HostCustom, ScopeDir)
	found, failed, err := RefreshOutdated(home, cwd, config)
	if err != nil || len(failed) != 0 || len(found) != 1 {
		t.Fatalf("refresh = %+v %v %v", found, failed, err)
	}
	if !found[0].Current || found[0].Host != HostCustom || found[0].Version != BundleVersion {
		t.Fatalf("our copy in the WorkBuddy directory = %+v", found[0])
	}
}

func TestRefreshOfARecordedDirectoryDecidesAgainUnderTheLock(t *testing.T) {
	home, cwd, config := t.TempDir(), t.TempDir(), t.TempDir()
	dir := hostSkillsDir(t, home)
	result, err := Install(InstallOptions{Dir: dir, Home: home, CWD: cwd, ConfigDir: config})
	if err != nil {
		t.Fatal(err)
	}
	fakeRelease(t, result.Path, "0.0.1", HostCustom, ScopeDir)
	// Another process holds the install lock of the skills directory and edits the copy
	// before letting go.
	release, err := auth.LockFile(filepath.Join(dir, ".muvloom-install.lock"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(result.Path, BodyFile), []byte("edited meanwhile"), 0o644)
		release()
	}()
	if _, failed, err := RefreshOutdated(home, cwd, config); err != nil || len(failed) != 0 {
		t.Fatal(failed, err)
	}
	if data, _ := os.ReadFile(filepath.Join(result.Path, BodyFile)); string(data) != "edited meanwhile" {
		t.Fatal("an edit made while waiting for the lock was overwritten")
	}
}

func TestBodyAndFilesServeTheBundledSkillOnly(t *testing.T) {
	want, err := fs.ReadFile(bundled, "assets/"+BodyFile)
	if err != nil {
		t.Fatal(err)
	}
	body, err := Body(BodyFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(want) {
		t.Fatal("Body does not return the embedded Skill")
	}
	files, err := Files()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < 2 || files[0] != BodyFile {
		t.Fatalf("Files = %v", files)
	}
	for _, name := range files {
		if _, err := Body(name); err != nil {
			t.Fatalf("Body(%q): %v", name, err)
		}
	}
	for _, name := range []string{"../../../etc/passwd", "/etc/passwd", "references/../../assets/SKILL.md", "", "references"} {
		if _, err := Body(name); err == nil {
			t.Fatalf("Body(%q) served a file outside the bundle", name)
		}
	}
}

func TestFrontmatterVersionReadsOnlyAPlainVersion(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"1.2.3":   "---\nname: muvloom\nversion: 1.2.3\n---\n# Body\nversion: 9.9.9\n",
		"quoted":  "---\nversion: \"2.0.0-beta1\"\n---\n",
		"missing": "---\nname: muvloom\n---\nversion: 3.0.0\n",
		"nobody":  "# No frontmatter\nversion: 4.0.0\n",
		"prose":   "---\nversion: see /Users/someone/notes.txt\n---\n",
	} {
		path := filepath.Join(dir, name+".md")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		want := map[string]string{"1.2.3": "1.2.3", "quoted": "2.0.0-beta1"}[name]
		if got := frontmatterVersion(path); got != want {
			t.Fatalf("%s: frontmatterVersion = %q, want %q", name, got, want)
		}
	}
	if got := frontmatterVersion(filepath.Join(dir, "absent.md")); got != "" {
		t.Fatalf("missing file = %q", got)
	}
}
