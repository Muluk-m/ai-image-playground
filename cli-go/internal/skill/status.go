package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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

	// Where the copy was found, which a refresh writes to; metadata may say otherwise
	// when a copy was moved by hand.
	foundHost, foundScope string
}

// Installed reports metadata for installed Skills in the user's home and the
// current project. Missing metadata is ignored so status remains read-only and
// useful after an interrupted or manually removed installation.
func Installed(home, cwd string) ([]Installation, error) {
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
	type location struct{ root, scope string }
	locations := []location{{home, "user"}}
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
		locations = append(locations, location{project, "project"})
	}
	result := make([]Installation, 0)
	for _, location := range locations {
		for _, host := range hosts {
			path := filepath.Join(location.root, host.dir, "skills", "muvloom")
			data, readErr := os.ReadFile(filepath.Join(path, ".muvloom-skill.json"))
			if errors.Is(readErr, os.ErrNotExist) {
				continue
			}
			if readErr != nil {
				return nil, readErr
			}
			var item Installation
			if err := json.Unmarshal(data, &item); err != nil {
				continue
			}
			item.Path = path
			item.foundHost, item.foundScope = host.name, location.scope
			if onDisk, hashErr := treeHash(path); hashErr == nil {
				item.Intact = onDisk == item.FileHash
			} else {
				item.Unverifiable = true
			}
			if _, bundledHash, bundleErr := bundleFiles(); bundleErr == nil {
				item.Current = item.Intact && item.FileHash == bundledHash
			}
			if item.Host == "" {
				item.Host = host.name
			}
			if item.Scope == "" {
				item.Scope = location.scope
			}
			result = append(result, item)
		}
	}
	return result, nil
}

// treeHash hashes an installed Skill the same way bundleFiles hashes the bundle,
// skipping the install metadata file.
func treeHash(root string) (string, error) {
	var files []bundleFile
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() == ".muvloom-skill.json" {
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
func refreshable(item Installation) bool {
	return item.Intact && VersionLess(item.Version, BundleVersion) &&
		item.Host == item.foundHost && item.Scope == item.foundScope
}

// RefreshOutdated replaces every copy the CLI installed that is unedited and of an older
// release than the bundle, so upgrading the CLI upgrades the Skills it installed. It writes
// where each copy was found, and decides again under the install lock, so a copy edited, or
// refreshed by another (possibly newer) CLI meanwhile, is left as it is. It returns the
// copies after refreshing and those it could not update.
func RefreshOutdated(home, cwd string) ([]Installation, []Refresh, error) {
	installed, err := Installed(home, cwd)
	if err != nil {
		return nil, nil, err
	}
	var failed []Refresh
	changed := false
	for _, item := range installed {
		if !refreshable(item) {
			continue
		}
		_, err := Install(InstallOptions{
			Host: item.foundHost, Scope: item.foundScope, Home: home, CWD: cwd,
			onlyIf: func(destination string) bool {
				current, err := Installed(home, cwd)
				if err != nil {
					return false
				}
				for _, again := range current {
					if again.Path == destination {
						return refreshable(again)
					}
				}
				return false
			},
		})
		switch {
		case err == nil:
			changed = true
		case !errors.Is(err, errNotNeeded):
			failed = append(failed, Refresh{Installation: item, Err: err})
		}
	}
	if changed {
		if installed, err = Installed(home, cwd); err != nil {
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
