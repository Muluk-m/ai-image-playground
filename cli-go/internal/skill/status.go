package skill

import (
	"encoding/json"
	"errors"
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
	locations := []struct {
		root  string
		scope string
	}{
		{home, "user"},
	}
	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	if project, projectErr := findProjectRoot(cwd); projectErr == nil && project != home {
		locations = append(locations, struct {
			root  string
			scope string
		}{project, "project"})
	}
	result := make([]Installation, 0)
	for _, location := range locations {
		for _, host := range []struct{ name, dir string }{{"claude-code", ".claude"}, {"codex", ".agents"}} {
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
