package skill

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

const (
	remoteCheckInterval    = 24 * time.Hour
	remoteManifestTimeout  = 3 * time.Second
	remoteArchiveTimeout   = 15 * time.Second
	maxManifestBytes       = 256 * 1024
	maxArchiveBytes        = 10 * 1024 * 1024
	maxArchiveFiles        = 128
	maxSingleFileBytes     = 2 * 1024 * 1024
	maxTotalExtractedBytes = 16 * 1024 * 1024
)

var (
	sha256HexRe    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	archiveNameRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*\.zip$`)
	dottedVerRe    = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,4}$`)
	officialWebMap = map[string]string{
		"https://api.muvloom.online":      "https://muvloom.online",
		"https://test-api.muvloom.online": "https://test.muvloom.online",
		"https://image-api.qiliangjia.one": "https://image-playground.qiliangjia.one",
	}
)

// ManifestOriginForAPI maps an official Muvloom API URL to the matching static web
// origin that serves /cli/skill-manifest.json and skill archives. Unknown or custom
// API URLs return ("", false) so the CLI never fetches manifests from untrusted hosts.
func ManifestOriginForAPI(apiURL string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	key := strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
	origin, ok := officialWebMap[key]
	return origin, ok
}

type RemoteManifest struct {
	SchemaVersion int                             `json:"schema_version"`
	Skill         string                          `json:"skill"`
	Version       string                          `json:"version"`
	BundleVersion string                          `json:"bundle_version"`
	Packages      map[string]RemoteManifestBundle `json:"packages"`
}

type RemoteManifestBundle struct {
	Archive       string               `json:"archive"`
	ArchiveSHA256 string               `json:"archive_sha256"`
	FileHash      string               `json:"file_hash"`
	Files         []RemoteManifestFile `json:"files"`
}

type RemoteManifestFile struct {
	Path   string `json:"path"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// RemoteUpdateOptions configures remote Skill checking and hot-updates.
type RemoteUpdateOptions struct {
	Home     string
	CWD      string
	StateDir string
	APIURL   string
	// BaseURL overrides ManifestOriginForAPI in tests (only https or loopback http).
	BaseURL string
	HTTP    *http.Client
	Now     func() time.Time
}

// RemoteUpdatedCopy records one installed Skill copy updated from the remote manifest.
type RemoteUpdatedCopy struct {
	Host        string `json:"host"`
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	FromVersion string `json:"from_version"`
	ToVersion   string `json:"to_version"`
	FileHash    string `json:"file_hash"`
}

// RemoteUpdateResult summarizes a remote Skill check or hot-update run.
type RemoteUpdateResult struct {
	Status        string              `json:"status"` // up_to_date, update_available, updated, skipped, disabled, unavailable
	AutoUpdate    bool                `json:"auto_update"`
	RemoteVersion string              `json:"remote_version,omitempty"`
	Updated       []RemoteUpdatedCopy `json:"updated,omitempty"`
	Reason        string              `json:"reason,omitempty"`
}

type remoteUpdateState struct {
	AutoUpdate        *bool     `json:"auto_update,omitempty"`
	LastCheckedAt     time.Time `json:"last_checked_at,omitempty"`
	LastRemoteVersion string    `json:"last_remote_version,omitempty"`
	LastUpdatedAt     time.Time `json:"last_updated_at,omitempty"`
}

func remoteStatePath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "skill-update.json")
}

func remoteLockPath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "skill-update.lock")
}

func readRemoteState(stateDir string) remoteUpdateState {
	if stateDir == "" {
		return remoteUpdateState{}
	}
	data, err := os.ReadFile(remoteStatePath(stateDir))
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return remoteUpdateState{}
	}
	var state remoteUpdateState
	if err := json.Unmarshal(data, &state); err != nil {
		return remoteUpdateState{}
	}
	return state
}

func writeRemoteState(stateDir string, state remoteUpdateState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return auth.WriteFileInPlace(remoteStatePath(stateDir), data)
}

// AutoUpdateEnabled reports whether automatic silent Skill hot-updates are enabled.
// Missing or unreadable state defaults to enabled (only explicit JSON false disables it).
func AutoUpdateEnabled(stateDir string) bool {
	state := readRemoteState(stateDir)
	return state.AutoUpdate == nil || *state.AutoUpdate
}

// SetAutoUpdate persists the user's automatic Skill hot-update preference in place.
func SetAutoUpdate(stateDir string, enabled bool) error {
	if stateDir == "" {
		return errors.New("state directory is required")
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "updates"), 0o700); err != nil {
		return err
	}
	release, err := auth.LockFile(remoteLockPath(stateDir), 2*time.Second)
	if err != nil {
		return err
	}
	defer release()
	state := readRemoteState(stateDir)
	val := enabled
	state.AutoUpdate = &val
	if enabled {
		// Re-enabling auto-update lets the next auth status check immediately instead
		// of waiting out an earlier throttle window.
		state.LastCheckedAt = time.Time{}
	}
	return writeRemoteState(stateDir, state)
}

// MaybeAutoUpdate performs a best-effort, 24h-throttled silent hot-update of intact
// installed Skill copies from the official Muvloom web origin. It never returns an error
// and never blocks the caller's command on network or verification failures.
func MaybeAutoUpdate(ctx context.Context, opts RemoteUpdateOptions) RemoteUpdateResult {
	if opts.StateDir == "" {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "no_state_dir"}
	}
	if !AutoUpdateEnabled(opts.StateDir) {
		return RemoteUpdateResult{Status: "disabled", AutoUpdate: false}
	}
	origin, ok := resolveManifestOrigin(opts)
	if !ok {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "unrecognized_origin"}
	}
	installed, err := Installed(opts.Home, opts.CWD)
	if err != nil || !hasRemoteCandidate(installed) {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "no_refreshable_skills"}
	}
	if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
		return RemoteUpdateResult{Status: "unavailable", AutoUpdate: true, Reason: "storage_unavailable"}
	}
	release, err := auth.LockFile(remoteLockPath(opts.StateDir), time.Second)
	if err != nil {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "check_in_progress"}
	}
	defer release()

	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	state := readRemoteState(opts.StateDir)
	if state.AutoUpdate != nil && !*state.AutoUpdate {
		return RemoteUpdateResult{Status: "disabled", AutoUpdate: false}
	}
	if !state.LastCheckedAt.IsZero() && !now.Before(state.LastCheckedAt) && now.Sub(state.LastCheckedAt) < remoteCheckInterval {
		return RemoteUpdateResult{
			Status:        "skipped",
			AutoUpdate:    true,
			RemoteVersion: state.LastRemoteVersion,
			Reason:        "throttled",
		}
	}
	// Persist the check timestamp before hitting the network so an offline machine
	// does not pay the 3-second manifest timeout on every command.
	state.LastCheckedAt = now
	_ = writeRemoteState(opts.StateDir, state)

	res, err := runRemoteUpdate(ctx, opts, origin, false, true, &state, now)
	if err != nil {
		return RemoteUpdateResult{Status: "unavailable", AutoUpdate: true, Reason: "check_or_update_failed"}
	}
	return res
}

// CheckOrUpdateRemote explicitly checks or updates installed Skills from the official
// Muvloom web origin, bypassing the 24h throttle and auto_update toggle.
func CheckOrUpdateRemote(ctx context.Context, opts RemoteUpdateOptions, checkOnly bool) (RemoteUpdateResult, error) {
	origin, ok := resolveManifestOrigin(opts)
	if !ok {
		return RemoteUpdateResult{}, errors.New("automatic Skill updates are only available for official Muvloom services")
	}
	autoEnabled := AutoUpdateEnabled(opts.StateDir)
	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	var release func()
	var state remoteUpdateState
	if opts.StateDir != "" {
		if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
			return RemoteUpdateResult{}, err
		}
		unlock, err := auth.LockFile(remoteLockPath(opts.StateDir), 2*time.Second)
		if err != nil {
			return RemoteUpdateResult{}, fmt.Errorf("another muvloom skill update is running: %w", err)
		}
		release = unlock
		state = readRemoteState(opts.StateDir)
	}
	if release != nil {
		defer release()
	}
	if !checkOnly {
		state.LastCheckedAt = now
	}
	return runRemoteUpdate(ctx, opts, origin, checkOnly, autoEnabled, &state, now)
}

func runRemoteUpdate(
	ctx context.Context,
	opts RemoteUpdateOptions,
	origin string,
	checkOnly bool,
	autoEnabled bool,
	state *remoteUpdateState,
	now time.Time,
) (RemoteUpdateResult, error) {
	httpClient := safeHTTPClient(opts.HTTP)
	manifest, err := fetchManifest(ctx, httpClient, origin)
	if err != nil {
		return RemoteUpdateResult{}, err
	}
	state.LastRemoteVersion = manifest.Version
	if opts.StateDir != "" {
		_ = writeRemoteState(opts.StateDir, *state)
	}

	installed, err := Installed(opts.Home, opts.CWD)
	if err != nil {
		return RemoteUpdateResult{}, err
	}
	var outdated []Installation
	for _, item := range installed {
		if !remoteRefreshable(item, manifest.Version) {
			continue
		}
		if _, ok := manifest.Packages[item.foundHost]; ok {
			outdated = append(outdated, item)
		}
	}
	if len(outdated) == 0 {
		return RemoteUpdateResult{
			Status:        "up_to_date",
			AutoUpdate:    autoEnabled,
			RemoteVersion: manifest.Version,
		}, nil
	}
	if checkOnly {
		return RemoteUpdateResult{
			Status:        "update_available",
			AutoUpdate:    autoEnabled,
			RemoteVersion: manifest.Version,
		}, nil
	}

	// Cache verified extracted files by archive name so claude-code and codex (or user +
	// project copies) share a single download.
	verifiedCache := map[string][]bundleFile{}
	var updated []RemoteUpdatedCopy
	var firstErr error
	for _, item := range outdated {
		pkg, ok := manifest.Packages[item.foundHost]
		if !ok {
			continue
		}
		files, cached := verifiedCache[pkg.Archive]
		if !cached {
			downloaded, dlErr := downloadAndVerifyPackage(ctx, httpClient, origin, pkg)
			if dlErr != nil {
				if firstErr == nil {
					firstErr = dlErr
				}
				continue
			}
			verifiedCache[pkg.Archive] = downloaded
			files = downloaded
		}
		applied, applyErr := applyInPlaceUpdate(item, opts.Home, opts.CWD, manifest.Version, pkg.FileHash, files)
		if applyErr != nil {
			if firstErr == nil {
				firstErr = applyErr
			}
			continue
		}
		if applied {
			updated = append(updated, RemoteUpdatedCopy{
				Host:        item.foundHost,
				Scope:       item.foundScope,
				Path:        item.Path,
				FromVersion: item.Version,
				ToVersion:   manifest.Version,
				FileHash:    pkg.FileHash,
			})
		}
	}
	if len(updated) > 0 {
		state.LastUpdatedAt = now
		if opts.StateDir != "" {
			_ = writeRemoteState(opts.StateDir, *state)
		}
		return RemoteUpdateResult{
			Status:        "updated",
			AutoUpdate:    autoEnabled,
			RemoteVersion: manifest.Version,
			Updated:       updated,
		}, nil
	}
	if firstErr != nil {
		return RemoteUpdateResult{}, firstErr
	}
	return RemoteUpdateResult{
		Status:        "up_to_date",
		AutoUpdate:    autoEnabled,
		RemoteVersion: manifest.Version,
	}, nil
}

func resolveManifestOrigin(opts RemoteUpdateOptions) (string, bool) {
	if strings.TrimSpace(opts.BaseURL) != "" {
		parsed, err := url.Parse(strings.TrimSpace(opts.BaseURL))
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", false
		}
		host := parsed.Hostname()
		local := host == "127.0.0.1" || host == "localhost" || host == "::1"
		if parsed.Scheme != "https" && !(parsed.Scheme == "http" && local) {
			return "", false
		}
		return strings.TrimRight(opts.BaseURL, "/"), true
	}
	return ManifestOriginForAPI(opts.APIURL)
}

func hasRemoteCandidate(installed []Installation) bool {
	for _, item := range installed {
		if item.Intact && item.Host == item.foundHost && item.Scope == item.foundScope {
			return true
		}
	}
	return false
}

func remoteRefreshable(item Installation, remoteVersion string) bool {
	return item.Intact &&
		VersionLess(item.Version, remoteVersion) &&
		item.Host == item.foundHost &&
		item.Scope == item.foundScope
}

func safeHTTPClient(base *http.Client) *http.Client {
	cloned := &http.Client{CheckRedirect: client.NoRedirects}
	if base != nil {
		cloned.Transport = base.Transport
	}
	return cloned
}

func httpGetBytes(ctx context.Context, httpClient *http.Client, targetURL string, timeout time.Duration, maxBytes int64) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response exceeded %d byte limit", maxBytes)
	}
	return body, nil
}

func fetchManifest(ctx context.Context, httpClient *http.Client, origin string) (RemoteManifest, error) {
	body, err := httpGetBytes(ctx, httpClient, origin+"/cli/skill-manifest.json", remoteManifestTimeout, maxManifestBytes)
	if err != nil {
		return RemoteManifest{}, fmt.Errorf("fetch skill manifest: %w", err)
	}
	var manifest RemoteManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return RemoteManifest{}, fmt.Errorf("parse skill manifest: %w", err)
	}
	if err := validateManifest(manifest); err != nil {
		return RemoteManifest{}, err
	}
	return manifest, nil
}

func validateManifest(m RemoteManifest) error {
	if m.SchemaVersion != 1 || m.Skill != "muvloom" || !dottedVerRe.MatchString(m.Version) {
		return errors.New("invalid skill manifest header")
	}
	if len(m.Packages) == 0 {
		return errors.New("skill manifest has no packages")
	}
	for host, pkg := range m.Packages {
		if _, ok := hostDir(host); !ok {
			return fmt.Errorf("unknown host %q in skill manifest", host)
		}
		if err := validateManifestBundle(pkg); err != nil {
			return fmt.Errorf("invalid package %q: %w", host, err)
		}
	}
	return nil
}

func validateManifestBundle(pkg RemoteManifestBundle) error {
	if !archiveNameRe.MatchString(pkg.Archive) {
		return fmt.Errorf("invalid archive name %q", pkg.Archive)
	}
	if !sha256HexRe.MatchString(pkg.ArchiveSHA256) || !sha256HexRe.MatchString(pkg.FileHash) {
		return errors.New("invalid sha256 in manifest package")
	}
	if len(pkg.Files) == 0 || len(pkg.Files) > maxArchiveFiles {
		return errors.New("invalid file count in manifest package")
	}
	seen := make(map[string]struct{}, len(pkg.Files))
	folded := make(map[string]struct{}, len(pkg.Files))
	var total int
	for _, f := range pkg.Files {
		if !isSafeRelativeSkillPath(f.Path) {
			return fmt.Errorf("unsafe path %q in manifest", f.Path)
		}
		if f.Bytes < 0 || f.Bytes > maxSingleFileBytes {
			return fmt.Errorf("invalid file size for %q", f.Path)
		}
		if !sha256HexRe.MatchString(f.SHA256) {
			return fmt.Errorf("invalid file sha256 for %q", f.Path)
		}
		if _, dup := seen[f.Path]; dup {
			return fmt.Errorf("duplicate path %q in manifest", f.Path)
		}
		lower := strings.ToLower(f.Path)
		if _, dup := folded[lower]; dup {
			return fmt.Errorf("case-colliding path %q in manifest", f.Path)
		}
		seen[f.Path] = struct{}{}
		folded[lower] = struct{}{}
		total += f.Bytes
		if total > maxTotalExtractedBytes {
			return errors.New("manifest exceeds total extracted size limit")
		}
	}
	return nil
}

func isSafeRelativeSkillPath(rel string) bool {
	if rel == "" || rel == ".muvloom-skill.json" || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\\x00") {
		return false
	}
	if path.Clean(rel) != rel {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func downloadAndVerifyPackage(ctx context.Context, httpClient *http.Client, origin string, pkg RemoteManifestBundle) ([]bundleFile, error) {
	zipBytes, err := httpGetBytes(ctx, httpClient, origin+"/cli/"+pkg.Archive, remoteArchiveTimeout, maxArchiveBytes)
	if err != nil {
		return nil, fmt.Errorf("download skill archive: %w", err)
	}
	archiveSum := sha256.Sum256(zipBytes)
	if hex.EncodeToString(archiveSum[:]) != pkg.ArchiveSHA256 {
		return nil, errors.New("skill archive checksum mismatch")
	}
	reader, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("open skill archive: %w", err)
	}
	if len(reader.File) > maxArchiveFiles*2 {
		return nil, errors.New("skill archive has too many entries")
	}
	expected := make(map[string]RemoteManifestFile, len(pkg.Files))
	for _, f := range pkg.Files {
		expected[f.Path] = f
	}
	seen := make(map[string]struct{}, len(pkg.Files))
	var extracted []bundleFile
	var totalBytes int
	for _, entry := range reader.File {
		if entry.Flags&0x1 != 0 {
			return nil, errors.New("encrypted entry in skill archive")
		}
		if entry.Mode()&fs.ModeSymlink != 0 {
			return nil, errors.New("symlink entry in skill archive")
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		if !entry.Mode().IsRegular() && entry.Mode() != 0 {
			return nil, fmt.Errorf("non-regular file %q in skill archive", entry.Name)
		}
		if !strings.HasPrefix(entry.Name, "muvloom/") {
			return nil, fmt.Errorf("unexpected archive path %q", entry.Name)
		}
		rel := strings.TrimPrefix(entry.Name, "muvloom/")
		if rel == ".muvloom-skill.json" {
			// WorkBuddy ZIPs carry install metadata for direct manual unpack; the updater
			// writes its own verified metadata after replacing files.
			continue
		}
		want, ok := expected[rel]
		if !ok {
			return nil, fmt.Errorf("unlisted file %q in skill archive", rel)
		}
		if _, dup := seen[rel]; dup {
			return nil, fmt.Errorf("duplicate file %q in skill archive", rel)
		}
		rc, err := entry.Open()
		if err != nil {
			return nil, fmt.Errorf("read %q from skill archive: %w", rel, err)
		}
		data, readErr := io.ReadAll(io.LimitReader(rc, maxSingleFileBytes+1))
		_ = rc.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read %q from skill archive: %w", rel, readErr)
		}
		if len(data) != want.Bytes {
			return nil, fmt.Errorf("file size mismatch for %q", rel)
		}
		totalBytes += len(data)
		if totalBytes > maxTotalExtractedBytes {
			return nil, errors.New("extracted archive exceeds size limit")
		}
		fileSum := sha256.Sum256(data)
		if hex.EncodeToString(fileSum[:]) != want.SHA256 {
			return nil, fmt.Errorf("file checksum mismatch for %q", rel)
		}
		seen[rel] = struct{}{}
		extracted = append(extracted, bundleFile{path: rel, data: data})
	}
	if len(seen) != len(expected) {
		return nil, errors.New("skill archive is missing manifest files")
	}
	if hashFiles(extracted) != pkg.FileHash {
		return nil, errors.New("extracted skill tree hash mismatch")
	}
	return extracted, nil
}

// applyInPlaceUpdate replaces an intact, older Skill installation in place under the
// per-directory install lock. Writing existing files in place (without renaming or
// deleting the directory) avoids triggering desktop sandbox file-replacement prompts,
// while rolling back from an in-memory snapshot if any write fails.
func applyInPlaceUpdate(
	item Installation,
	home, cwd string,
	targetVersion, targetHash string,
	newFiles []bundleFile,
) (bool, error) {
	root, destination, err := resolveSkillRootAndDest(item.foundHost, item.foundScope, home, cwd)
	if err != nil {
		return false, err
	}
	if destination != item.Path {
		return false, fmt.Errorf("resolved Skill path %s does not match %s", destination, item.Path)
	}
	if err := checkDestination(item.foundScope, root, destination); err != nil {
		return false, err
	}
	release, err := auth.LockFile(filepath.Join(filepath.Dir(destination), ".muvloom-install.lock"), installLockWait)
	if err != nil {
		return false, fmt.Errorf("another muvloom is updating %s: %w", destination, err)
	}
	defer release()

	if err := checkDestination(item.foundScope, root, destination); err != nil {
		return false, err
	}
	// Re-check under the lock: another process or the user may have updated or edited the copy.
	current, err := Installed(home, cwd)
	if err != nil {
		return false, err
	}
	stillRefreshable := false
	for _, again := range current {
		if again.Path == destination {
			stillRefreshable = remoteRefreshable(again, targetVersion)
			break
		}
	}
	if !stillRefreshable {
		return false, nil
	}

	// Snapshot every regular file (including .muvloom-skill.json) so any mid-update failure
	// rolls back cleanly.
	snapshot, err := snapshotSkillDir(destination)
	if err != nil {
		return false, err
	}

	// Verify no symlinks sit on any target path before writing anything.
	newMap := make(map[string][]byte, len(newFiles))
	for _, f := range newFiles {
		newMap[f.path] = f.data
		target := filepath.Join(destination, filepath.FromSlash(f.path))
		if err := refuseSymlinks(destination, target); err != nil {
			return false, err
		}
	}
	if err := refuseSymlinks(destination, filepath.Join(destination, ".muvloom-skill.json")); err != nil {
		return false, err
	}

	var created []string
	rollback := func() {
		for _, rel := range created {
			_ = os.Remove(filepath.Join(destination, filepath.FromSlash(rel)))
			if dir := path.Dir(rel); dir != "." {
				_ = os.Remove(filepath.Join(destination, filepath.FromSlash(dir)))
			}
		}
		for rel, data := range snapshot {
			_ = writeSkillFileInPlace(filepath.Join(destination, filepath.FromSlash(rel)), data)
		}
	}

	// Write new and updated files in place (no rename, no delete).
	for _, f := range newFiles {
		if _, existed := snapshot[f.path]; !existed {
			created = append(created, f.path)
		}
		if err := writeSkillFileInPlace(filepath.Join(destination, filepath.FromSlash(f.path)), f.data); err != nil {
			rollback()
			return false, fmt.Errorf("write %s: %w", f.path, err)
		}
	}

	// Remove files from the previous verified snapshot that no longer exist in the new manifest.
	var obsoleteDirs []string
	for rel := range snapshot {
		if rel == ".muvloom-skill.json" {
			continue
		}
		if _, keep := newMap[rel]; keep {
			continue
		}
		target := filepath.Join(destination, filepath.FromSlash(rel))
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			rollback()
			return false, fmt.Errorf("remove obsolete %s: %w", rel, err)
		}
		if dir := path.Dir(rel); dir != "." {
			obsoleteDirs = append(obsoleteDirs, dir)
		}
	}
	// Prune any emptied subdirectories deepest-first (best effort).
	sort.Slice(obsoleteDirs, func(i, j int) bool { return len(obsoleteDirs[i]) > len(obsoleteDirs[j]) })
	for _, dir := range obsoleteDirs {
		_ = os.Remove(filepath.Join(destination, filepath.FromSlash(dir)))
	}

	// Write .muvloom-skill.json LAST so a crash before this point never marks a half-written tree intact.
	meta := metadata{
		Skill:    "muvloom",
		Version:  targetVersion,
		Host:     item.foundHost,
		Scope:    item.foundScope,
		FileHash: targetHash,
	}
	metaBytes, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		rollback()
		return false, err
	}
	metaBytes = append(metaBytes, '\n')
	if err := writeSkillFileInPlace(filepath.Join(destination, ".muvloom-skill.json"), metaBytes); err != nil {
		rollback()
		return false, fmt.Errorf("write Skill metadata: %w", err)
	}
	return true, nil
}

func resolveSkillRootAndDest(host, scope, home, cwd string) (string, string, error) {
	dir, ok := hostDir(host)
	if !ok {
		return "", "", fmt.Errorf("unsupported host %q", host)
	}
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", "", err
		}
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return "", "", err
	}
	root := home
	if scope == "project" {
		if cwd == "" {
			cwd, err = os.Getwd()
			if err != nil {
				return "", "", err
			}
		}
		projectDir, err := findProjectRoot(cwd)
		if err != nil {
			return "", "", err
		}
		if projectDir, err = filepath.EvalSymlinks(projectDir); err != nil {
			return "", "", err
		}
		root = projectDir
	}
	return root, filepath.Join(root, dir, "skills", "muvloom"), nil
}

func snapshotSkillDir(root string) (map[string][]byte, error) {
	snap := map[string][]byte{}
	err := filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s is not a regular file", p)
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		snap[filepath.ToSlash(rel)] = data
		return nil
	})
	return snap, err
}

func writeSkillFileInPlace(target string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := file.Chmod(0o644); err != nil {
			file.Close()
			return err
		}
	}
	if _, err := file.WriteAt(data, 0); err != nil {
		file.Close()
		return err
	}
	if err := file.Truncate(int64(len(data))); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
