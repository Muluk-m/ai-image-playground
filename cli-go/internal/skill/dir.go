package skill

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// A copy installed with `skill install --dir` carries this host label and scope: the host is
// named by whoever ran the install, not by this CLI, and the directory itself is the scope.
const (
	HostCustom = "custom"
	ScopeDir   = "dir"
	// HostWorkBuddy labels WorkBuddy's user skills directory, which WorkBuddy fills from a
	// zip it downloads itself.
	HostWorkBuddy = "workbuddy"
	// SkillFolder is the folder a host loads the Skill from, inside its skills directory.
	SkillFolder = "muvloom"
)

// workBuddySkillsDir is WorkBuddy's user skills directory: `~/.workbuddy/skills`, and on
// Windows the same path under the user profile (`%USERPROFILE%\.workbuddy\skills`), so no
// platform branch is needed. WorkBuddy's skill-package documentation does not say where a
// skill is stored; this follows the install instruction the website ships inside the
// WorkBuddy Skill package, which names the user's home directory on every platform.
func workBuddySkillsDir(home string) string {
	return filepath.Join(home, ".workbuddy", "skills")
}

// installDir installs into a skills directory the host names. That directory is the parent:
// the Skill lands in <dir>/muvloom, the layout every host uses (~/.claude/skills/muvloom,
// ~/.workbuddy/skills/muvloom), so one directory can hold several skills.
//
// The safety rules of a host install hold here too: the destination is never replaced
// through a symlink, the replacement is atomic, it holds the install lock of the skills
// directory and decides again under it, and a directory that is the home directory or a
// filesystem root is refused.
func installDir(opts InstallOptions) (Result, error) {
	dir, err := resolveSkillsDir(opts)
	if err != nil {
		return Result{}, err
	}
	destination := filepath.Join(dir, SkillFolder)
	files, hash, err := bundleFiles()
	if err != nil {
		return Result{}, err
	}
	// A function of its own, so the install lock is released before the registry is written:
	// the two locks are only ever taken in this order.
	if err := func() error {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		release, lockErr := auth.LockFile(filepath.Join(dir, ".muvloom-install.lock"), installLockWait)
		if lockErr != nil {
			return fmt.Errorf("another muvloom is updating %s: %w", destination, lockErr)
		}
		defer release()
		// Checked again under the lock: the directory may have been replaced while waiting.
		if err := refuseSymlinks(dir, destination); err != nil {
			return err
		}
		if opts.onlyIf != nil {
			replace, err := opts.onlyIf(destination)
			if err != nil {
				return err
			}
			if !replace {
				return errNotNeeded
			}
		}
		return installTree(destination, files, metadata{
			Skill: SkillFolder, Version: BundleVersion, Host: HostCustom, Scope: ScopeDir, FileHash: hash,
		})
	}(); err != nil {
		return Result{}, err
	}
	// The Skill is in place; only the record of where it went can still fail. Say both, so
	// nobody installs twice to fix a config directory that is not writable.
	if err := rememberDir(opts.ConfigDir, dir); err != nil {
		return Result{}, fmt.Errorf("installed the Skill at %s but could not record the directory, so `muvloom auth status` will not keep it up to date: %w", destination, err)
	}
	return Result{Host: HostCustom, Scope: ScopeDir, Dir: dir, Path: destination, Version: BundleVersion, FileHash: hash}, nil
}

// resolveSkillsDir turns --dir into an absolute skills directory, refusing the ones where
// installing would replace something that is not a skills directory.
func resolveSkillsDir(opts InstallOptions) (string, error) {
	dir := strings.TrimSpace(opts.Dir)
	if dir == "" {
		return "", errors.New("--dir needs the host's skills directory")
	}
	if strings.HasPrefix(dir, "~") {
		// An unexpanded ~ would create a directory literally named "~".
		return "", errors.New("--dir needs a real path: the shell did not expand ~")
	}
	if !filepath.IsAbs(dir) {
		cwd := opts.CWD
		if cwd == "" {
			var err error
			if cwd, err = os.Getwd(); err != nil {
				return "", fmt.Errorf("find current directory: %w", err)
			}
		}
		dir = filepath.Join(cwd, dir)
	}
	dir = filepath.Clean(dir)
	if filepath.Base(dir) == SkillFolder {
		return "", fmt.Errorf("--dir is the host's skills directory, which holds %s; pass %s instead", SkillFolder, filepath.Dir(dir))
	}
	if parent := filepath.Dir(dir); parent == dir {
		return "", fmt.Errorf("refusing to install into the filesystem root %s; pass the host's skills directory", dir)
	}
	home := opts.Home
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return "", fmt.Errorf("find home directory: %w", err)
		}
	}
	// Compare the paths with their symlinks resolved: a link must not turn the home
	// directory into a skills directory whose whole content would be replaced.
	if realPath(dir) == realPath(home) {
		return "", errors.New("refusing to install into the home directory; pass the host's skills directory inside it")
	}
	return dir, nil
}

// realPath resolves the symlinks in the part of path that exists, so two paths can be
// compared even when one of them is still to be created.
func realPath(path string) string {
	rest := ""
	for {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return filepath.Join(path, rest)
		}
		rest = filepath.Join(filepath.Base(path), rest)
		path = parent
	}
}

// The registry of `--dir` installs lives beside the CLI's own files, holds nothing but
// directory paths, and is written in place like every other file in that directory.
const (
	registryFile = "skill-installs.json"
	registryLock = "skill-installs.lock"
	registryWait = 5 * time.Second
	// registryLimit bounds the file: a host that installs in a loop cannot grow it without end.
	registryLimit = 50
)

type registry struct {
	SchemaVersion int      `json:"schema_version"`
	Directories   []string `json:"directories"`
}

func registryDir(configDir string) string {
	if configDir != "" {
		return configDir
	}
	return auth.ConfigDir()
}

// loadRegistry lists the recorded skills directories. A missing, unreadable or damaged file
// reads as none: status stays read-only and useful.
func loadRegistry(configDir string) []string {
	data, err := os.ReadFile(filepath.Join(registryDir(configDir), registryFile))
	if err != nil {
		return nil
	}
	var stored registry
	if err := json.Unmarshal(data, &stored); err != nil {
		return nil
	}
	var dirs []string
	for _, dir := range stored.Directories {
		// Only absolute paths: a relative one would mean a different place in every session.
		if dir = filepath.Clean(strings.TrimSpace(dir)); filepath.IsAbs(dir) && !slices.Contains(dirs, dir) {
			dirs = append(dirs, dir)
		}
		if len(dirs) == registryLimit {
			break
		}
	}
	sort.Strings(dirs)
	return dirs
}

// rememberDir records a skills directory so `skill status` and the refresh find it again. A
// directory already recorded writes nothing, so a refresh does not rewrite the file.
func rememberDir(configDir, dir string) error {
	root := registryDir(configDir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	release, err := auth.LockFile(filepath.Join(root, registryLock), registryWait)
	if err != nil {
		return err
	}
	defer release()
	dirs := loadRegistry(configDir)
	if slices.Contains(dirs, dir) {
		return nil
	}
	if len(dirs) >= registryLimit {
		return fmt.Errorf("%d install directories are already recorded in %s", len(dirs), filepath.Join(root, registryFile))
	}
	dirs = append(dirs, dir)
	sort.Strings(dirs)
	data, err := json.MarshalIndent(registry{SchemaVersion: 1, Directories: dirs}, "", "  ")
	if err != nil {
		return err
	}
	return auth.WriteFileInPlace(filepath.Join(root, registryFile), append(data, '\n'))
}
