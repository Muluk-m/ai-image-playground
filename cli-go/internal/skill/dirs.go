package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// customHost marks a copy installed with `skill install --dir` into a skills directory
// that no --host value covers. Such copies are registered, so status and refresh find them.
const (
	customHost  = "custom"
	customScope = "dir"
)

const registryLockWait = 5 * time.Second

// registryPath lists every --dir install; it lives with the credentials, outside any
// host or project directory.
func registryPath() string { return filepath.Join(auth.ConfigDir(), "skill-dirs.json") }

type registry struct {
	Paths []string `json:"paths"`
}

// RegisteredDirs returns the Skill directories recorded by `skill install --dir`. A missing
// or unreadable registry is empty: status stays read-only and never fails on it.
func RegisteredDirs() []string {
	data, err := os.ReadFile(registryPath())
	if err != nil {
		return nil
	}
	var reg registry
	if json.Unmarshal(data, &reg) != nil {
		return nil
	}
	return reg.Paths
}

func register(destination string) error {
	path := registryPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	release, err := auth.LockFile(path+".lock", registryLockWait)
	if err != nil {
		return fmt.Errorf("another muvloom is updating %s: %w", path, err)
	}
	defer release()
	paths := RegisteredDirs()
	if slices.Contains(paths, destination) {
		return nil
	}
	data, err := json.MarshalIndent(registry{Paths: append(paths, destination)}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".skill-dirs-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// installDir writes the bundled Skill to <Dir>/muvloom and registers it. A refresh passes
// the same parent with onlyIf set.
func installDir(opts InstallOptions) (Result, error) {
	parent, err := filepath.Abs(opts.Dir)
	if err != nil {
		return Result{}, fmt.Errorf("resolve --dir: %w", err)
	}
	destination := filepath.Join(parent, "muvloom")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Result{}, err
	}
	release, err := auth.LockFile(filepath.Join(parent, ".muvloom-install.lock"), installLockWait)
	if err != nil {
		return Result{}, fmt.Errorf("another muvloom is updating %s: %w", destination, err)
	}
	defer release()
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return Result{}, fmt.Errorf("%s is a symlink; update the Skill at its target instead", destination)
	}
	if opts.onlyIf != nil {
		replace, err := opts.onlyIf(destination)
		if err != nil {
			return Result{}, err
		}
		if !replace {
			return Result{}, errNotNeeded
		}
	}
	files, hash, err := bundleFilesForHost(customHost)
	if err != nil {
		return Result{}, err
	}
	if err := installTree(destination, files, metadata{Skill: "muvloom", Version: SkillVersion, Host: customHost, Scope: customScope, FileHash: hash}, false); err != nil {
		return Result{}, err
	}
	if err := register(destination); err != nil {
		return Result{}, fmt.Errorf("installed %s but could not record it for updates: %w", destination, err)
	}
	return Result{Host: customHost, Scope: customScope, Path: destination, Version: SkillVersion, FileHash: hash}, nil
}

// registeredInstallations inspects every registered directory not already reported. A
// directory that is gone or holds no muvloom metadata is skipped: the user removed it.
func registeredInstallations(seen []Installation) []Installation {
	var result []Installation
	for _, path := range RegisteredDirs() {
		if slices.ContainsFunc(seen, func(item Installation) bool { return item.Path == path }) {
			continue
		}
		if _, err := os.Stat(filepath.Join(path, ".muvloom-skill.json")); errors.Is(err, os.ErrNotExist) {
			continue
		}
		found, item, err := inspectAtPath(path, customHost, customScope)
		if err != nil {
			if found {
				result = append(result, Installation{Skill: "muvloom", Host: customHost, Scope: customScope, Path: path, Unverifiable: true, foundHost: customHost, foundScope: customScope})
			}
			continue
		}
		if found {
			result = append(result, item)
		}
	}
	return result
}

// Content is the bundled Skill as one text: SKILL.md, then every reference, each under a
// path heading, for hosts that cannot install a Skill and read it at the start of a session.
func Content() (string, error) {
	files, _, err := bundleFilesForHost("")
	if err != nil {
		return "", err
	}
	var out []byte
	for _, f := range files {
		if f.path != "SKILL.md" && filepath.Dir(f.path) != "references" {
			continue // launch scripts and host UI metadata are not instructions
		}
		if len(out) > 0 {
			out = append(out, "\n\n"...)
		}
		out = append(out, "<!-- muvloom skill file: "+f.path+" -->\n"...)
		out = append(out, f.data...)
	}
	return string(out), nil
}
