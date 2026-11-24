package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
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
	paths, _ := readRegistry()
	return paths
}

// readRegistry reports a registry that exists but cannot be parsed, so a write keeps it aside
// instead of replacing every earlier entry with only the new one.
func readRegistry() ([]string, error) {
	data, err := os.ReadFile(registryPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var reg registry
	if err := json.Unmarshal(data, &reg); err != nil {
		return nil, err
	}
	return reg.Paths, nil
}

// ReinstallCommand is the command that replaces this copy with the bundled Skill, ready to paste
// into the user's shell.
func ReinstallCommand(item Installation) string {
	if item.Host == customHost || item.foundHost == customHost {
		return "muvloom skill install --dir " + shellQuote(filepath.Dir(item.Path), runtime.GOOS)
	}
	return fmt.Sprintf("muvloom skill install --host %s --scope %s", item.Host, item.Scope)
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
	paths, readErr := readRegistry()
	if readErr != nil {
		// Keep the damaged file for a person to recover the other entries from; never replace it
		// without a copy.
		kept := fmt.Sprintf("%s.bad-%d", path, time.Now().UnixNano())
		if err := os.Rename(path, kept); err != nil {
			return fmt.Errorf("%s cannot be read (%v) and could not be kept aside: %w", path, readErr, err)
		}
	}
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
	// A host's own skills directory stays that host's install, so status, refresh and hot
	// updates keep treating it as one.
	if host, scope, project, ok := knownHostDir(parent, opts.Home, opts.CWD); ok {
		cwd := opts.CWD
		if project != "" {
			cwd = project // another project's host directory: install it as that project's copy
		}
		return Install(InstallOptions{Host: host, Scope: scope, Home: opts.Home, CWD: cwd, onlyIf: opts.onlyIf})
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

// knownHostDir reports whether dir is the skills directory a --host install uses: a host's
// user-scope directory, or its project-scope directory in the current project or in any other
// project (which status finds when run there). For a project directory it also returns that
// project's root.
func knownHostDir(dir, home, cwd string) (string, string, string, bool) {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	same := func(a, b string) bool {
		if ra, err := filepath.EvalSymlinks(a); err == nil {
			a = ra
		}
		if rb, err := filepath.EvalSymlinks(b); err == nil {
			b = rb
		}
		return filepath.Clean(a) == filepath.Clean(b)
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	project := ""
	if cwd != "" {
		project, _ = findProjectRoot(cwd)
	}
	for _, host := range hosts {
		if home != "" && same(dir, filepath.Join(home, filepath.FromSlash(host.userDir), "skills")) {
			return host.name, "user", "", true
		}
		if project != "" && same(dir, filepath.Join(project, filepath.FromSlash(host.projectDir), "skills")) {
			return host.name, "project", project, true
		}
		// <root>/<projectDir>/skills where <root> is itself a project root.
		suffix := string(filepath.Separator) + filepath.Join(filepath.FromSlash(host.projectDir), "skills")
		clean := filepath.Clean(dir)
		if root, ok := strings.CutSuffix(clean, suffix); ok && root != "" {
			if found, err := findProjectRoot(root); err == nil && same(found, root) {
				return host.name, "project", root, true
			}
		}
	}
	return "", "", "", false
}

// shellQuote quotes a path as one literal argument: single quotes in POSIX shells (nothing
// inside expands), and in PowerShell, where a single quote is escaped by doubling it.
func shellQuote(value, goos string) string {
	if goos == "windows" {
		return "'" + strings.ReplaceAll(value, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
