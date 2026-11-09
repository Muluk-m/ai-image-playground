package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Installation is the on-disk metadata used by auth status and automation to
// determine which Skill release is active without reading the Skill body.
type Installation struct {
	Skill    string `json:"skill"`
	Host     string `json:"host"`
	Scope    string `json:"scope"`
	Path     string `json:"path"`
	Version  string `json:"version"`
	FileHash string `json:"file_hash"`
	// Intact is false when the files on disk no longer hash to FileHash (edited,
	// partially deleted, or metadata copied without its files).
	Intact bool `json:"intact"`
	// Current is true when this install matches the Skill bundled with this CLI.
	Current bool `json:"current"`
	// Unverifiable is true when the files could not be hashed (a missing or unreadable
	// file, or something other than a regular file): incomplete rather than edited.
	Unverifiable bool `json:"unverifiable,omitempty"`
	// Managed is true when this CLI installed the copy, which is what its install metadata
	// records. A copy a host installed by itself (WorkBuddy's) has none: its Version is
	// whatever its SKILL.md frontmatter says, its own numbering rather than a CLI release,
	// and Intact then means "these are exactly the files this CLI ships".
	Managed bool `json:"managed"`
	// SkillsDir is the host's skills directory a copy outside the fixed locations was found
	// in; Path is <SkillsDir>/muvloom and `skill install --dir SkillsDir` replaces it.
	SkillsDir string `json:"skills_dir,omitempty"`

	// Where the copy was found, which a refresh writes to; metadata may say otherwise
	// when a copy was moved by hand.
	foundHost, foundScope string
}

// location is a place a Skill copy can be found: a root plus the host directory inside it,
// or a skills directory named by a host.
type location struct {
	// root and host name a fixed location, dir a skills directory.
	root, dir string
	host      string
	scope     string
}

// Installed reports the Skill copies found in the fixed Claude Code and Codex locations of
// the user's home and the current project, in WorkBuddy's user skills directory, and in the
// skills directories recorded by `skill install --dir` (configDir holds that record; empty
// means the CLI's own config directory). Missing metadata is ignored so status remains
// read-only and useful after an interrupted or manually removed installation, and a copy a
// host installed by itself is reported as unmanaged rather than left out.
func Installed(home, cwd, configDir string) ([]Installation, error) {
	locations, err := scanLocations(home, cwd, configDir)
	if err != nil {
		return nil, err
	}
	_, bundledHash, bundleErr := bundleFiles()
	if bundleErr != nil {
		return nil, bundleErr
	}
	result := make([]Installation, 0)
	for _, location := range locations {
		path := filepath.Join(location.skillsDir(), SkillFolder)
		if slices.ContainsFunc(result, func(found Installation) bool { return found.Path == path }) {
			continue
		}
		item, found, err := scan(location, path, bundledHash)
		if err != nil {
			return nil, err
		}
		if found {
			result = append(result, item)
		}
	}
	return result, nil
}

// skillsDir is the directory holding the Skill folder: the host's skills directory.
func (l location) skillsDir() string {
	if l.dir != "" {
		return l.dir
	}
	return filepath.Join(l.root, hostDirOrEmpty(l.host), "skills")
}

func hostDirOrEmpty(name string) string {
	dir, _ := hostDir(name)
	return dir
}

// scanLocations lists every place to look, in the order status reports them: the fixed host
// locations first, then the skills directories named by a host.
func scanLocations(home, cwd, configDir string) ([]location, error) {
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return nil, err
		}
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	roots := []location{{root: home, scope: "user"}}
	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	realHome := home
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		realHome = resolved
	}
	project, projectErr := findProjectRoot(cwd)
	if projectErr == nil {
		if resolved, err := filepath.EvalSymlinks(project); err == nil {
			project = resolved
		}
	}
	if projectErr == nil && project != realHome {
		roots = append(roots, location{root: project, scope: "project"})
	}
	var locations []location
	for _, root := range roots {
		for _, host := range hosts {
			locations = append(locations, location{root: root.root, host: host.name, scope: root.scope})
		}
	}
	// WorkBuddy installs its own copy from a zip it downloads, so this directory usually has
	// no install metadata of ours; it is reported all the same.
	locations = append(locations, location{dir: workBuddySkillsDir(home), host: HostWorkBuddy, scope: ScopeDir})
	for _, dir := range loadRegistry(configDir) {
		locations = append(locations, location{dir: dir, host: HostCustom, scope: ScopeDir})
	}
	return locations, nil
}

// scan reads one copy. found is false where no Skill is installed.
func scan(where location, path, bundledHash string) (Installation, bool, error) {
	var item Installation
	data, readErr := os.ReadFile(filepath.Join(path, metadataFile))
	switch {
	case readErr == nil:
		if json.Unmarshal(data, &item) == nil {
			item.Managed = true
		}
	case errors.Is(readErr, os.ErrNotExist):
	default:
		return Installation{}, false, readErr
	}
	if !item.Managed {
		// No metadata of ours, or none we can read as ours: a copy its host installed and
		// keeps up to date itself, if there is a Skill here at all.
		if info, err := os.Lstat(filepath.Join(path, BodyFile)); err != nil || !info.Mode().IsRegular() {
			return Installation{}, false, nil
		}
		item = Installation{Skill: SkillFolder}
	}
	item.Path = path
	if where.dir != "" {
		item.SkillsDir = where.dir
		// A copy in a skills directory was installed with --dir, whatever host filled the
		// directory; metadata naming a fixed host means it was moved here by hand.
		item.foundHost, item.foundScope = HostCustom, ScopeDir
	} else {
		item.foundHost, item.foundScope = where.host, where.scope
	}
	onDisk, hashErr := treeHash(path)
	if hashErr != nil {
		item.Unverifiable = true
	}
	if item.Managed {
		item.Intact = hashErr == nil && onDisk == item.FileHash
		item.Current = item.Intact && item.FileHash == bundledHash
		if item.Host == "" {
			item.Host = where.host
		}
		if item.Scope == "" {
			item.Scope = where.scope
		}
		return item, true, nil
	}
	item.Host, item.Scope = where.host, where.scope
	item.foundHost, item.foundScope = item.Host, item.Scope
	// Without metadata the only thing that can be verified is whether these are the files
	// this CLI ships. If they are, the release is known; if not, an older release and an
	// edited copy look the same, so the version is reported as its own SKILL.md states it.
	item.FileHash = onDisk
	item.Intact = hashErr == nil && onDisk == bundledHash
	item.Current = item.Intact
	if item.Intact {
		item.Version = BundleVersion
	} else {
		item.Version = frontmatterVersion(filepath.Join(path, BodyFile))
	}
	return item, true, nil
}

// frontmatterVersion reads `version:` from a SKILL.md frontmatter block. A host that
// packages the Skill itself (WorkBuddy) numbers that field in its own way, so the value is
// reported as read and never compared with a CLI release. Anything that is not a plain
// version token is ignored rather than passed on.
func frontmatterVersion(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	head := make([]byte, 8192)
	n, err := io.ReadFull(file, head)
	if n == 0 || (err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF)) {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(string(head[:n]), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return ""
	}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			return ""
		}
		value, ok := strings.CutPrefix(line, "version:")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if versionToken.MatchString(value) {
			return value
		}
		return ""
	}
	return ""
}

// versionToken is what may be reported from a file this CLI did not write: no spaces, no
// local paths, nothing that could carry a sentence into JSON output.
var versionToken = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$`)

// treeHash hashes an installed Skill the same way bundleFiles hashes the bundle,
// skipping the install metadata file.
func treeHash(root string) (string, error) {
	var files []bundleFile
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() == metadataFile {
			return nil
		}
		if !entry.Type().IsRegular() {
			// Never follow a link (or block on a FIFO); an installed Skill only has files.
			return fmt.Errorf("%s is not a regular file", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, bundleFile{path: filepath.ToSlash(rel), data: data})
		return nil
	})
	if err != nil {
		return "", err
	}
	return hashFiles(files), nil
}

// Refresh is one installed copy RefreshOutdated could not update, and why.
type Refresh struct {
	Installation
	Err error
}

// refreshable is a copy this CLI should replace: unedited, of an older release, and found
// where its metadata says it was installed.
//
// A copy without our metadata (WorkBuddy's, which that host installs and updates itself) is
// only ever touched when Intact says its files are exactly the ones this CLI ships — and
// then it is already current, so nothing is replaced. An older or repackaged copy cannot be
// told apart from an edited one, so it is reported and left to its host.
func refreshable(item Installation) bool {
	return item.Intact && VersionLess(item.Version, BundleVersion) &&
		item.Host == item.foundHost && item.Scope == item.foundScope
}

// RefreshOutdated replaces every copy the CLI installed that is unedited and of an older
// release than the bundle, so upgrading the CLI upgrades the Skills it installed: the fixed
// host locations and every skills directory recorded by `skill install --dir`. It writes
// where each copy was found, and decides again under the install lock, so a copy edited, or
// refreshed by another (possibly newer) CLI meanwhile, is left as it is. It returns the
// copies after refreshing and those it could not update.
func RefreshOutdated(home, cwd, configDir string) ([]Installation, []Refresh, error) {
	installed, err := Installed(home, cwd, configDir)
	if err != nil {
		return nil, nil, err
	}
	var failed []Refresh
	attempted := false
	for _, item := range installed {
		if !refreshable(item) {
			continue
		}
		attempted = true
		opts := InstallOptions{
			Host: item.foundHost, Scope: item.foundScope, Home: home, CWD: cwd, ConfigDir: configDir,
			onlyIf: func(destination string) (bool, error) {
				current, err := Installed(home, cwd, configDir)
				if err != nil {
					return false, err
				}
				for _, again := range current {
					if again.Path == destination {
						return refreshable(again), nil
					}
				}
				return false, nil
			},
		}
		if item.SkillsDir != "" {
			opts.Host, opts.Scope, opts.Dir = "", "", item.SkillsDir
		}
		if _, err := Install(opts); err != nil && !errors.Is(err, errNotNeeded) {
			failed = append(failed, Refresh{Installation: item, Err: err})
		}
	}
	// Re-read after any attempt: this process, or another one, may have changed a copy.
	if attempted {
		if installed, err = Installed(home, cwd, configDir); err != nil {
			return nil, failed, err
		}
	}
	return installed, failed, nil
}

// VersionLess compares dotted numeric versions; an unknown format is never older.
func VersionLess(current, other string) bool {
	if other == "" {
		return false
	}
	cur := strings.Split(strings.TrimPrefix(current, "v"), ".")
	req := strings.Split(strings.TrimPrefix(other, "v"), ".")
	for i := 0; i < max(len(cur), len(req)); i++ {
		var c, r int
		var err error
		if i < len(cur) {
			if c, err = strconv.Atoi(cur[i]); err != nil {
				return false
			}
		}
		if i < len(req) {
			if r, err = strconv.Atoi(req[i]); err != nil {
				return false
			}
		}
		if c != r {
			return c < r
		}
	}
	return false
}
