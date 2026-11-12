package skill

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// BundleVersion is tied to the native CLI release. Keep the bundled Skill and
// the executable on the same version so hosts can report what was installed.
const BundleVersion = "0.2.5"

//go:embed assets
var bundled embed.FS

type InstallOptions struct {
	Host  string
	Scope string
	// Output is the parent directory for --host generic (the Skill is written to
	// <Output>/muvloom). Empty means the current working directory. It is ignored
	// for claude-code and codex, which always use their host skill directories.
	Output string
	Home   string
	CWD    string
	// onlyIf, when set, decides under the install lock whether to replace the copy at the
	// destination; false skips the install with errNotNeeded, an error stops it.
	onlyIf func(destination string) (bool, error)
}

// errNotNeeded reports an install skipped because onlyIf said the copy should stay.
var errNotNeeded = errors.New("the installed Skill no longer needs replacing")

// installLockWait bounds how long an install waits for another process replacing the same copy.
const installLockWait = 10 * time.Second

type Result struct {
	Host       string `json:"host"`
	Scope      string `json:"scope"`
	ProjectDir string `json:"project_dir,omitempty"`
	Path       string `json:"path"`
	Version    string `json:"version"`
	FileHash   string `json:"file_hash"`
}

type metadata struct {
	Skill    string `json:"skill"`
	Version  string `json:"version"`
	Host     string `json:"host"`
	Scope    string `json:"scope"`
	FileHash string `json:"file_hash"`
}

// hosts lists each supported agent host, in display order, with the directory holding its skills.
var hosts = []struct{ name, dir string }{{"claude-code", ".claude"}, {"codex", ".agents"}}

func hostDir(name string) (string, bool) {
	for _, host := range hosts {
		if host.name == name {
			return host.dir, true
		}
	}
	return "", false
}

func Install(opts InstallOptions) (Result, error) {
	if opts.Host == "generic" {
		return installGeneric(opts)
	}
	dir, ok := hostDir(opts.Host)
	if !ok {
		return Result{}, fmt.Errorf("unsupported host %q", opts.Host)
	}
	if opts.Scope != "user" && opts.Scope != "project" {
		return Result{}, fmt.Errorf("unsupported scope %q", opts.Scope)
	}
	home := opts.Home
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return Result{}, fmt.Errorf("find home directory: %w", err)
		}
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return Result{}, fmt.Errorf("resolve home directory: %w", err)
	}
	root := home
	projectDir := ""
	if opts.Scope == "project" {
		cwd := opts.CWD
		if cwd == "" {
			cwd, err = os.Getwd()
			if err != nil {
				return Result{}, fmt.Errorf("find current directory: %w", err)
			}
		}
		projectDir, err = findProjectRoot(cwd)
		if err != nil {
			return Result{}, err
		}
		// Compare real paths: a symlinked working directory must not turn a project
		// install into a write into the home directory (or wherever the link points).
		if projectDir, err = filepath.EvalSymlinks(projectDir); err != nil {
			return Result{}, fmt.Errorf("resolve project directory: %w", err)
		}
		if realHome, err := filepath.EvalSymlinks(home); err == nil && projectDir == realHome {
			return Result{}, errors.New("the project root resolved to the home directory; use --scope user instead")
		}
		root = projectDir
	}
	destination := filepath.Join(root, dir, "skills", "muvloom")
	if err := checkDestination(opts.Scope, root, destination); err != nil {
		return Result{}, err
	}
	// Every install of a host's skills directory (refresh or `skill install`) holds this lock,
	// so two replacements of one directory never interleave. The path is checked again under
	// it: the parents could have changed while waiting.
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return Result{}, err
	}
	release, err := auth.LockFile(filepath.Join(filepath.Dir(destination), ".muvloom-install.lock"), installLockWait)
	if err != nil {
		return Result{}, fmt.Errorf("another muvloom is updating %s: %w", destination, err)
	}
	defer release()
	if err := checkDestination(opts.Scope, root, destination); err != nil {
		return Result{}, err
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
	files, hash, err := bundleFiles()
	if err != nil {
		return Result{}, err
	}
	if err := installTree(destination, files, metadata{Skill: "muvloom", Version: BundleVersion, Host: opts.Host, Scope: opts.Scope, FileHash: hash}); err != nil {
		return Result{}, err
	}
	return Result{Host: opts.Host, Scope: opts.Scope, ProjectDir: projectDir, Path: destination, Version: BundleVersion, FileHash: hash}, nil
}

// installGeneric writes the bundled Skill to a local muvloom/ directory the user
// can upload to a host that has no --host value. It never writes into ~/.claude,
// ~/.agents, or any unverified host configuration directory.
func installGeneric(opts InstallOptions) (Result, error) {
	cwd := opts.CWD
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return Result{}, fmt.Errorf("find current directory: %w", err)
		}
	}
	parent := opts.Output
	if parent == "" {
		parent = cwd
	}
	parent, err := filepath.Abs(parent)
	if err != nil {
		return Result{}, fmt.Errorf("resolve output directory: %w", err)
	}
	destination := parent
	if filepath.Base(parent) != "muvloom" {
		destination = filepath.Join(parent, "muvloom")
	}
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return Result{}, fmt.Errorf("%s is a symlink; choose another output directory", destination)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return Result{}, err
	}
	release, err := auth.LockFile(filepath.Join(filepath.Dir(destination), ".muvloom-install.lock"), installLockWait)
	if err != nil {
		return Result{}, fmt.Errorf("another muvloom is updating %s: %w", destination, err)
	}
	defer release()
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return Result{}, fmt.Errorf("%s is a symlink; choose another output directory", destination)
	}
	files, hash, err := bundleFiles()
	if err != nil {
		return Result{}, err
	}
	if err := installTree(destination, files, metadata{Skill: "muvloom", Version: BundleVersion, Host: "generic", Scope: "local", FileHash: hash}); err != nil {
		return Result{}, err
	}
	return Result{Host: "generic", Scope: "local", Path: destination, Version: BundleVersion, FileHash: hash}, nil
}

// checkDestination refuses a destination reached through a symlink.
func checkDestination(scope, root, destination string) error {
	// A project can ship `.claude` or `.agents/skills` as a symlink pointing anywhere;
	// following it would write (and replace) a directory outside the project. A user's own
	// home directory may symlink these on purpose (dotfiles), so only projects are checked.
	if scope == "project" {
		return refuseSymlinks(root, destination)
	}
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		// Replacing the link would silently detach a dotfiles-managed Skill.
		return fmt.Errorf("%s is a symlink; update the Skill at its target instead", destination)
	}
	return nil
}

func findProjectRoot(start string) (string, error) {
	path, err := filepath.Abs(start)
	if err != nil {
		return "", fmt.Errorf("resolve project directory: %w", err)
	}
	if info, statErr := os.Stat(path); statErr == nil && !info.IsDir() {
		path = filepath.Dir(path)
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return "", fmt.Errorf("inspect project directory: %w", statErr)
	}
	for {
		if isProjectMarker(path) {
			return path, nil
		}
		parent := filepath.Dir(path)
		if parent == path {
			// Never fall back to the filesystem root: installing would replace /.claude/skills.
			return "", errors.New("no project root found (looked for .git, go.mod or package.json); run from inside a project or use --scope user")
		}
		path = parent
	}
}

func isProjectMarker(path string) bool {
	for _, marker := range []string{".git", "go.mod", "package.json"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

type bundleFile struct {
	path string
	data []byte
}

func bundleFiles() ([]bundleFile, string, error) {
	var files []bundleFile
	err := fs.WalkDir(bundled, "assets", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(bundled, path)
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "assets/")
		files = append(files, bundleFile{path: rel, data: data})
		return nil
	})
	if err != nil {
		return nil, "", fmt.Errorf("read bundled Skill: %w", err)
	}
	return files, hashFiles(files), nil
}

// hashFiles is the bundle identity recorded at install time and checked by status.
func hashFiles(files []bundleFile) string {
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	h := sha256.New()
	for _, file := range files {
		// Include names and lengths so concatenation cannot make two bundles
		// hash alike merely because their bytes happen to concatenate equally.
		fmt.Fprintf(h, "%s\x00%d\x00", file.path, len(file.data))
		h.Write(file.data)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func installTree(destination string, files []bundleFile, meta metadata) error {
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create Skill parent: %w", err)
	}
	tmp, err := os.MkdirTemp(parent, ".muvloom-skill-")
	if err != nil {
		return fmt.Errorf("create Skill staging directory: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(tmp)
		}
	}()
	for _, file := range files {
		target := filepath.Join(tmp, filepath.FromSlash(file.path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create Skill directory: %w", err)
		}
		if err := os.WriteFile(target, file.data, 0o644); err != nil {
			return fmt.Errorf("write Skill file: %w", err)
		}
	}
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Skill metadata: %w", err)
	}
	metaBytes = append(metaBytes, '\n')
	if err := os.WriteFile(filepath.Join(tmp, ".muvloom-skill.json"), metaBytes, 0o644); err != nil {
		return fmt.Errorf("write Skill metadata: %w", err)
	}
	// Move the old install aside first and put it back if the swap fails, so a failed
	// upgrade never leaves the host without a working Skill.
	backup := ""
	if _, err := os.Lstat(destination); err == nil {
		backup = destination + ".previous-" + filepath.Base(tmp)
		if err := os.Rename(destination, backup); err != nil {
			return fmt.Errorf("move existing Skill aside: %w", err)
		}
	}
	if err := os.Rename(tmp, destination); err != nil {
		if backup != "" {
			if restoreErr := os.Rename(backup, destination); restoreErr != nil {
				return fmt.Errorf("install Skill: %w; the previous Skill is kept at %s (restore failed: %v)", err, backup, restoreErr)
			}
		}
		return fmt.Errorf("install Skill: %w", err)
	}
	keep = true
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	return nil
}

// refuseSymlinks rejects any existing symlink between root (exclusive) and destination.
func refuseSymlinks(root, destination string) error {
	rel, err := filepath.Rel(root, destination)
	if err != nil || strings.HasPrefix(rel, "..") {
		return fmt.Errorf("Skill path %s is outside %s", destination, root)
	}
	current := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to install through the symlink %s", current)
		}
	}
	return nil
}
