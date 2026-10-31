package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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
	if project, projectErr := findProjectRoot(cwd); projectErr == nil && project != home {
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
			if onDisk, hashErr := treeHash(path); hashErr == nil {
				item.Intact = onDisk == item.FileHash
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
