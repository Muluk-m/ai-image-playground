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
	// AutoUpdateBudget bounds the total wall-clock time MaybeAutoUpdate may spend inside
	// auth status (manifest + archive downloads + in-place writes) so normal commands
	// never stall when downloads are slow.
	AutoUpdateBudget       = 6 * time.Second
	autoLockWait           = 500 * time.Millisecond
	remoteCheckInterval    = 24 * time.Hour
	staleCheckedPathAge    = 30 * 24 * time.Hour
	remoteManifestTimeout  = 3 * time.Second
	remoteArchiveTimeout   = 15 * time.Second
	maxManifestBytes       = 256 * 1024
	maxArchiveBytes        = 10 * 1024 * 1024
	maxArchiveFiles        = 128
	maxSingleFileBytes     = 2 * 1024 * 1024
	maxTotalExtractedBytes = 16 * 1024 * 1024
)

var (
	// Sentinel errors for stable CLI error classification (never leaking raw OS/network strings).
	ErrUnsupportedService = errors.New("unsupported service for remote skill updates")
	ErrRemoteUnavailable  = errors.New("remote skill manifest or archive unavailable")
	ErrInvalidManifest    = errors.New("invalid remote skill manifest or archive")
	ErrUpdateBusy         = errors.New("another skill update is in progress")

	sha256HexRe    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	archiveNameRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*\.zip$`)
	dottedVerRe    = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,4}$`)
	officialWebMap = map[string]string{
		"https://api.muvloom.online":       "https://muvloom.online",
		"https://test-api.muvloom.online":  "https://test.muvloom.online",
		"https://image-api.qiliangjia.one": "https://image-playground.qiliangjia.one",
	}
)

// RemoteErrorReason maps an internal Skill hot-update error to a short, stable reason
// without exposing local filesystem paths or raw transport text.
func RemoteErrorReason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrUnsupportedService):
		return "unsupported service"
	case errors.Is(err, ErrUpdateBusy), errors.Is(err, auth.ErrLockTimeout):
		return "another muvloom process is updating"
	case errors.Is(err, ErrRemoteUnavailable):
		return "network or service error"
	case errors.Is(err, ErrInvalidManifest):
		return "verification failed"
	case errors.Is(err, os.ErrPermission):
		return "permission denied"
	case strings.Contains(err.Error(), "symlink"):
		return "symlink refused"
	default:
		return "storage error"
	}
}

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

// RemoteUpdateFailure records one installed Skill copy that could not be updated.
type RemoteUpdateFailure struct {
	Host   string `json:"host"`
	Scope  string `json:"scope"`
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// RemoteUpdateResult summarizes a remote Skill check or hot-update run.
type RemoteUpdateResult struct {
	Status        string                `json:"status"` // up_to_date, update_available, updated, partial, skipped, disabled, unavailable
	AutoUpdate    bool                  `json:"auto_update"`
	RemoteVersion string                `json:"remote_version,omitempty"`
	Updated       []RemoteUpdatedCopy   `json:"updated,omitempty"`
	Failed        []RemoteUpdateFailure `json:"failed,omitempty"`
	Reason        string                `json:"reason,omitempty"`
}

type remoteUpdateState struct {
	AutoUpdate        *bool                `json:"auto_update,omitempty"`
	LastCheckedAt     time.Time            `json:"last_checked_at,omitempty"`
	CheckedPaths      map[string]time.Time `json:"checked_paths,omitempty"`
	LastRemoteVersion string               `json:"last_remote_version,omitempty"`
	LastUpdatedAt     time.Time            `json:"last_updated_at,omitempty"`
}

// updateJournal persists a pre-update snapshot in <StateDir>/updates/ so an interrupted
// process (SIGKILL, crash, or failed rollback) automatically heals on the next run.
type updateJournal struct {
	Root        string            `json:"root"`
	Destination string            `json:"destination"`
	Host        string            `json:"host"`
	Scope       string            `json:"scope"`
	FromHash    string            `json:"from_hash"`
	Snapshot    map[string][]byte `json:"snapshot"`
	Planned     []string          `json:"planned,omitempty"`
}

func remoteStatePath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "skill-update.json")
}

func remoteLockPath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "skill-update.lock")
}

func journalPathForDest(stateDir, destination string) string {
	if stateDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(destination))
	return filepath.Join(stateDir, "updates", "tx-"+hex.EncodeToString(sum[:8])+".json")
}

func readRemoteState(stateDir string) remoteUpdateState {
	if stateDir == "" {
		return remoteUpdateState{}
	}
	path := remoteStatePath(stateDir)
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(20 * time.Millisecond)
		}
		data, err := os.ReadFile(path)
		if err != nil || len(bytes.TrimSpace(data)) == 0 {
			return remoteUpdateState{}
		}
		var state remoteUpdateState
		if err := json.Unmarshal(data, &state); err == nil {
			return state
		}
	}
	return remoteUpdateState{}
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
		state.CheckedPaths = nil
	}
	return writeRemoteState(stateDir, state)
}

// MaybeAutoUpdate performs a best-effort, per-copy 24h-throttled silent hot-update of
// intact installed Skill copies from the official Muvloom web origin within a strict
// overall time budget. It never returns an error and never blocks the caller's command.
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
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, AutoUpdateBudget)
		defer cancel()
	}
	if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
		return RemoteUpdateResult{Status: "unavailable", AutoUpdate: true, Reason: "storage_unavailable"}
	}
	release, err := auth.LockFile(remoteLockPath(opts.StateDir), autoLockWait)
	if err != nil {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "check_in_progress"}
	}
	defer release()

	// Heal any interrupted update from an earlier crashed process before inspecting installs.
	recoverInterruptedUpdates(ctx, opts.StateDir, autoLockWait)

	installed, err := Installed(opts.Home, opts.CWD)
	if err != nil {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "no_refreshable_skills"}
	}
	var candidates []Installation
	for _, item := range installed {
		if item.Intact && item.Host == item.foundHost && item.Scope == item.foundScope {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		return RemoteUpdateResult{Status: "skipped", AutoUpdate: true, Reason: "no_refreshable_skills"}
	}

	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	state := readRemoteState(opts.StateDir)
	if state.AutoUpdate != nil && !*state.AutoUpdate {
		return RemoteUpdateResult{Status: "disabled", AutoUpdate: false}
	}
	needsCheck := false
	for _, item := range candidates {
		checkedAt := state.CheckedPaths[item.Path]
		if checkedAt.IsZero() && len(state.CheckedPaths) == 0 {
			checkedAt = state.LastCheckedAt
		}
		if checkedAt.IsZero() || now.Before(checkedAt) || now.Sub(checkedAt) >= remoteCheckInterval {
			needsCheck = true
			break
		}
	}
	if !needsCheck {
		return RemoteUpdateResult{
			Status:        "skipped",
			AutoUpdate:    true,
			RemoteVersion: state.LastRemoteVersion,
			Reason:        "throttled",
		}
	}
	// Persist per-path check timestamps before hitting the network so an offline machine
	// does not pay the manifest timeout on every command, while newly encountered projects
	// still get checked independently.
	if state.CheckedPaths == nil {
		state.CheckedPaths = map[string]time.Time{}
	}
	for p, ts := range state.CheckedPaths {
		if now.Sub(ts) > staleCheckedPathAge {
			delete(state.CheckedPaths, p)
		}
	}
	for _, item := range candidates {
		state.CheckedPaths[item.Path] = now
	}
	state.LastCheckedAt = now
	_ = writeRemoteState(opts.StateDir, state)

	res, err := runRemoteUpdate(ctx, opts, origin, false, true, &state, now, autoLockWait)
	if err != nil {
		return RemoteUpdateResult{Status: "unavailable", AutoUpdate: true, Reason: "check_or_update_failed"}
	}
	return res
}

// CheckOrUpdateRemote explicitly checks or updates installed Skills from the official
// Muvloom web origin, bypassing the 24h throttle and auto_update toggle. When checkOnly
// is true, it performs a strictly read-only check without creating directories, taking
// locks, or writing local state files.
func CheckOrUpdateRemote(ctx context.Context, opts RemoteUpdateOptions, checkOnly bool) (RemoteUpdateResult, error) {
	origin, ok := resolveManifestOrigin(opts)
	if !ok {
		return RemoteUpdateResult{}, ErrUnsupportedService
	}
	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	if checkOnly {
		autoEnabled := AutoUpdateEnabled(opts.StateDir)
		return runRemoteUpdate(ctx, opts, origin, true, autoEnabled, nil, now, installLockWait)
	}
	var release func()
	var state remoteUpdateState
	if opts.StateDir != "" {
		if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
			return RemoteUpdateResult{}, err
		}
		unlock, err := auth.LockFile(remoteLockPath(opts.StateDir), 2*time.Second)
		if err != nil {
			if errors.Is(err, auth.ErrLockTimeout) {
				return RemoteUpdateResult{}, fmt.Errorf("%w: %w", ErrUpdateBusy, err)
			}
			return RemoteUpdateResult{}, err
		}
		release = unlock
		recoverInterruptedUpdates(ctx, opts.StateDir, installLockWait)
		state = readRemoteState(opts.StateDir)
	}
	if release != nil {
		defer release()
	}
	autoEnabled := state.AutoUpdate == nil || *state.AutoUpdate
	state.LastCheckedAt = now
	return runRemoteUpdate(ctx, opts, origin, false, autoEnabled, &state, now, installLockWait)
}

func runRemoteUpdate(
	ctx context.Context,
	opts RemoteUpdateOptions,
	origin string,
	checkOnly bool,
	autoEnabled bool,
	state *remoteUpdateState,
	now time.Time,
	lockWait time.Duration,
) (RemoteUpdateResult, error) {
	httpClient := safeHTTPClient(opts.HTTP)
	manifest, err := fetchManifest(ctx, httpClient, origin)
	if err != nil {
		return RemoteUpdateResult{}, err
	}
	if state != nil {
		state.LastRemoteVersion = manifest.Version
		if opts.StateDir != "" {
			_ = writeRemoteState(opts.StateDir, *state)
		}
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

	// Cache both raw downloaded archive bytes and failed archive downloads so shared
	// archives are fetched at most once, while still verifying hashes independently per host.
	archiveCache := map[string][]byte{}
	archiveErrCache := map[string]error{}
	var updated []RemoteUpdatedCopy
	var failed []RemoteUpdateFailure
	var firstErr error
	for _, item := range outdated {
		if ctx.Err() != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("%w: %w", ErrRemoteUnavailable, ctx.Err())
			}
			failed = append(failed, RemoteUpdateFailure{
				Host:   item.foundHost,
				Scope:  item.foundScope,
				Path:   item.Path,
				Reason: RemoteErrorReason(firstErr),
			})
			break
		}
		pkg, ok := manifest.Packages[item.foundHost]
		if !ok {
			continue
		}
		if prevErr, failedBefore := archiveErrCache[pkg.Archive]; failedBefore {
			if firstErr == nil {
				firstErr = prevErr
			}
			failed = append(failed, RemoteUpdateFailure{
				Host:   item.foundHost,
				Scope:  item.foundScope,
				Path:   item.Path,
				Reason: RemoteErrorReason(prevErr),
			})
			continue
		}
		zipBytes, cached := archiveCache[pkg.Archive]
		if !cached {
			downloaded, dlErr := downloadArchiveBytes(ctx, httpClient, origin, pkg.Archive)
			if dlErr != nil {
				archiveErrCache[pkg.Archive] = dlErr
				if firstErr == nil {
					firstErr = dlErr
				}
				failed = append(failed, RemoteUpdateFailure{
					Host:   item.foundHost,
					Scope:  item.foundScope,
					Path:   item.Path,
					Reason: RemoteErrorReason(dlErr),
				})
				continue
			}
			archiveCache[pkg.Archive] = downloaded
			zipBytes = downloaded
		}
		files, verifyErr := verifyPackageArchive(zipBytes, pkg)
		if verifyErr != nil {
			if firstErr == nil {
				firstErr = verifyErr
			}
			failed = append(failed, RemoteUpdateFailure{
				Host:   item.foundHost,
				Scope:  item.foundScope,
				Path:   item.Path,
				Reason: RemoteErrorReason(verifyErr),
			})
			continue
		}
		applied, applyErr := applyInPlaceUpdate(item, opts.Home, opts.CWD, opts.StateDir, manifest.Version, pkg.FileHash, files, lockWait)
		if applyErr != nil {
			if firstErr == nil {
				firstErr = applyErr
			}
			failed = append(failed, RemoteUpdateFailure{
				Host:   item.foundHost,
				Scope:  item.foundScope,
				Path:   item.Path,
				Reason: RemoteErrorReason(applyErr),
			})
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
		if state != nil {
			state.LastUpdatedAt = now
			if opts.StateDir != "" {
				_ = writeRemoteState(opts.StateDir, *state)
			}
		}
		status := "updated"
		if len(failed) > 0 {
			status = "partial"
		}
		return RemoteUpdateResult{
			Status:        status,
			AutoUpdate:    autoEnabled,
			RemoteVersion: manifest.Version,
			Updated:       updated,
			Failed:        failed,
		}, nil
	}
	if firstErr != nil {
		return RemoteUpdateResult{
			Status:        "unavailable",
			AutoUpdate:    autoEnabled,
			RemoteVersion: manifest.Version,
			Failed:        failed,
		}, firstErr
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
		return RemoteManifest{}, fmt.Errorf("%w: fetch skill manifest: %w", ErrRemoteUnavailable, err)
	}
	var manifest RemoteManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return RemoteManifest{}, fmt.Errorf("%w: parse skill manifest: %w", ErrInvalidManifest, err)
	}
	if err := validateManifest(manifest); err != nil {
		return RemoteManifest{}, fmt.Errorf("%w: %w", ErrInvalidManifest, err)
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
	if rel == "" || strings.EqualFold(rel, ".muvloom-skill.json") || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\\x00") {
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

func downloadArchiveBytes(ctx context.Context, httpClient *http.Client, origin, archive string) ([]byte, error) {
	zipBytes, err := httpGetBytes(ctx, httpClient, origin+"/cli/"+archive, remoteArchiveTimeout, maxArchiveBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: download skill archive: %w", ErrRemoteUnavailable, err)
	}
	return zipBytes, nil
}

func verifyPackageArchive(zipBytes []byte, pkg RemoteManifestBundle) ([]bundleFile, error) {
	archiveSum := sha256.Sum256(zipBytes)
	if hex.EncodeToString(archiveSum[:]) != pkg.ArchiveSHA256 {
		return nil, fmt.Errorf("%w: skill archive checksum mismatch", ErrInvalidManifest)
	}
	reader, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("%w: open skill archive: %w", ErrInvalidManifest, err)
	}
	if len(reader.File) > maxArchiveFiles*2 {
		return nil, fmt.Errorf("%w: skill archive has too many entries", ErrInvalidManifest)
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
			return nil, fmt.Errorf("%w: encrypted entry in skill archive", ErrInvalidManifest)
		}
		if entry.Mode()&fs.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: symlink entry in skill archive", ErrInvalidManifest)
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		if !entry.Mode().IsRegular() && entry.Mode() != 0 {
			return nil, fmt.Errorf("%w: non-regular file %q in skill archive", ErrInvalidManifest, entry.Name)
		}
		if !strings.HasPrefix(entry.Name, "muvloom/") {
			return nil, fmt.Errorf("%w: unexpected archive path %q", ErrInvalidManifest, entry.Name)
		}
		rel := strings.TrimPrefix(entry.Name, "muvloom/")
		if strings.EqualFold(rel, ".muvloom-skill.json") {
			// WorkBuddy ZIPs carry install metadata for direct manual unpack; the updater
			// writes its own verified metadata after replacing files.
			continue
		}
		want, ok := expected[rel]
		if !ok {
			return nil, fmt.Errorf("%w: unlisted file %q in skill archive", ErrInvalidManifest, rel)
		}
		if _, dup := seen[rel]; dup {
			return nil, fmt.Errorf("%w: duplicate file %q in skill archive", ErrInvalidManifest, rel)
		}
		rc, err := entry.Open()
		if err != nil {
			return nil, fmt.Errorf("%w: read %q from skill archive: %w", ErrInvalidManifest, rel, err)
		}
		data, readErr := io.ReadAll(io.LimitReader(rc, maxSingleFileBytes+1))
		_ = rc.Close()
		if readErr != nil {
			return nil, fmt.Errorf("%w: read %q from skill archive: %w", ErrInvalidManifest, rel, readErr)
		}
		if len(data) != want.Bytes {
			return nil, fmt.Errorf("%w: file size mismatch for %q", ErrInvalidManifest, rel)
		}
		totalBytes += len(data)
		if totalBytes > maxTotalExtractedBytes {
			return nil, fmt.Errorf("%w: extracted archive exceeds size limit", ErrInvalidManifest)
		}
		fileSum := sha256.Sum256(data)
		if hex.EncodeToString(fileSum[:]) != want.SHA256 {
			return nil, fmt.Errorf("%w: file checksum mismatch for %q", ErrInvalidManifest, rel)
		}
		seen[rel] = struct{}{}
		extracted = append(extracted, bundleFile{path: rel, data: data})
	}
	if len(seen) != len(expected) {
		return nil, fmt.Errorf("%w: skill archive is missing manifest files", ErrInvalidManifest)
	}
	if hashFiles(extracted) != pkg.FileHash {
		return nil, fmt.Errorf("%w: extracted skill tree hash mismatch", ErrInvalidManifest)
	}
	return extracted, nil
}

// applyInPlaceUpdate replaces an intact, older Skill installation in place under the
// per-directory install lock. A persistent rollback journal is written under StateDir
// before mutating destination so even an interrupted process heals automatically on the
// next run. Existing unchanged paths are overwritten in place (avoiding rename/delete
// prompts in desktop sandboxes), while file<->directory transitions and directory/file
// case-only renames are cleaned up cleanly before writing and verified against targetHash
// before updating .muvloom-skill.json.
func applyInPlaceUpdate(
	item Installation,
	home, cwd, stateDir string,
	targetVersion, targetHash string,
	newFiles []bundleFile,
	lockWait time.Duration,
) (bool, error) {
	if lockWait <= 0 {
		lockWait = installLockWait
	}
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
	release, err := auth.LockFile(filepath.Join(filepath.Dir(destination), ".muvloom-install.lock"), lockWait)
	if err != nil {
		if errors.Is(err, auth.ErrLockTimeout) {
			return false, fmt.Errorf("%w: %w", ErrUpdateBusy, err)
		}
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

	// Snapshot every regular file (including .muvloom-skill.json) and persist the crash-recovery
	// journal under StateDir BEFORE touching any file inside destination.
	snapshot, err := snapshotSkillDir(destination)
	if err != nil {
		return false, err
	}
	planned := make([]string, 0, len(newFiles))
	newMap := make(map[string][]byte, len(newFiles))
	newFolded := make(map[string]string, len(newFiles))
	newDirFolded := map[string]string{}
	for _, f := range newFiles {
		planned = append(planned, f.path)
		newMap[f.path] = f.data
		newFolded[strings.ToLower(f.path)] = f.path
		for _, dir := range parentDirs(f.path) {
			newDirFolded[strings.ToLower(dir)] = dir
		}
	}
	if err := refuseSymlinks(destination, filepath.Join(destination, ".muvloom-skill.json")); err != nil {
		return false, err
	}

	journal := updateJournal{
		Root:        root,
		Destination: destination,
		Host:        item.foundHost,
		Scope:       item.foundScope,
		FromHash:    item.FileHash,
		Snapshot:    snapshot,
		Planned:     planned,
	}
	journalPath := journalPathForDest(stateDir, destination)
	if journalPath != "" {
		jBytes, err := json.Marshal(journal)
		if err != nil {
			return false, err
		}
		if err := auth.WriteFileInPlace(journalPath, jBytes); err != nil {
			return false, fmt.Errorf("persist update journal: %w", err)
		}
	}

	clearJournal := func() {
		if journalPath != "" {
			_ = os.Truncate(journalPath, 0)
		}
	}
	rollback := func() {
		if restoreFromJournal(journal, true) == nil {
			clearJournal()
		}
		// If rollback itself fails, keep journalPath on disk so the next startup recovers it.
	}

	// Pre-cleanup: remove any existing files (and emptied directories) that conflict with
	// file<->directory transitions or file/directory case-only renames before writing newFiles.
	preRemoved := map[string]bool{}
	var preDirs []string
	for oldRel := range snapshot {
		if strings.EqualFold(oldRel, ".muvloom-skill.json") {
			continue
		}
		oldParents := parentDirs(oldRel)
		needsPreRemove := false
		// 1. File -> Directory transition (exact or case-folded).
		if _, isNewDir := newDirFolded[strings.ToLower(oldRel)]; isNewDir {
			needsPreRemove = true
		}
		// 2. Directory -> File transition or directory-level case-only rename.
		for _, d := range oldParents {
			if _, fileReplacesDir := newFolded[strings.ToLower(d)]; fileReplacesDir {
				needsPreRemove = true
			}
			if newDir, foldedMatch := newDirFolded[strings.ToLower(d)]; foldedMatch && newDir != d {
				needsPreRemove = true
			}
		}
		// 3. File-level case-only rename.
		if _, exact := newMap[oldRel]; !exact {
			if newRel, foldedMatch := newFolded[strings.ToLower(oldRel)]; foldedMatch && newRel != oldRel {
				needsPreRemove = true
			}
		}
		if needsPreRemove {
			if err := os.Remove(filepath.Join(destination, filepath.FromSlash(oldRel))); err != nil && !errors.Is(err, os.ErrNotExist) {
				rollback()
				return false, fmt.Errorf("prepare layout transition for %s: %w", oldRel, err)
			}
			preRemoved[oldRel] = true
			preDirs = append(preDirs, oldParents...)
		}
	}
	pruneDirsDeepestFirst(destination, preDirs)

	// Write new and updated files in place (zero rename/delete for unchanged paths).
	for _, f := range newFiles {
		target := filepath.Join(destination, filepath.FromSlash(f.path))
		if err := refuseSymlinks(destination, target); err != nil {
			rollback()
			return false, err
		}
		if err := writeSkillFileInPlace(target, f.data); err != nil {
			rollback()
			return false, fmt.Errorf("write %s: %w", f.path, err)
		}
	}

	// Remove remaining obsolete files from the previous verified snapshot.
	var obsoleteDirs []string
	for rel := range snapshot {
		if strings.EqualFold(rel, ".muvloom-skill.json") || preRemoved[rel] {
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
		obsoleteDirs = append(obsoleteDirs, parentDirs(rel)...)
	}
	pruneDirsDeepestFirst(destination, obsoleteDirs)

	// Verify actual on-disk tree hash BEFORE committing .muvloom-skill.json so a filesystem
	// mismatch (e.g. unexpected casing) can never leave a broken Intact=false install.
	actualHash, err := treeHash(destination)
	if err != nil || actualHash != targetHash {
		rollback()
		if err != nil {
			return false, fmt.Errorf("verify updated Skill tree: %w", err)
		}
		return false, fmt.Errorf("%w: on-disk Skill tree hash did not match manifest", ErrInvalidManifest)
	}

	// Write .muvloom-skill.json LAST, then clear the recovery journal.
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
	clearJournal()
	return true, nil
}

// recoverInterruptedUpdates heals any Skill directory whose earlier hot-update was
// interrupted by a crash or failed rollback, using the persisted journal in StateDir.
// It honors ctx cancellation/deadline so normal commands never stall on unrelated locks.
func recoverInterruptedUpdates(ctx context.Context, stateDir string, lockWait time.Duration) {
	if stateDir == "" || ctx.Err() != nil {
		return
	}
	updatesDir := filepath.Join(stateDir, "updates")
	entries, err := os.ReadDir(updatesDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		name := entry.Name()
		if !entry.Type().IsRegular() || !strings.HasPrefix(name, "tx-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		jPath := filepath.Join(updatesDir, name)
		data, err := os.ReadFile(jPath)
		if err != nil || len(bytes.TrimSpace(data)) == 0 {
			continue
		}
		var journal updateJournal
		if err := json.Unmarshal(data, &journal); err != nil || journal.Destination == "" || len(journal.Snapshot) == 0 {
			continue
		}
		wait := lockWait
		if deadline, ok := ctx.Deadline(); ok {
			rem := time.Until(deadline)
			if rem <= 0 {
				return
			}
			if rem < wait {
				wait = rem
			}
		}
		release, err := auth.LockFile(filepath.Join(filepath.Dir(journal.Destination), ".muvloom-install.lock"), wait)
		if err != nil {
			continue
		}
		// Reject symlinked destinations or project ancestors before reading or touching anything.
		if journal.Root != "" && journal.Scope != "" {
			if checkDestination(journal.Scope, journal.Root, journal.Destination) != nil {
				release()
				continue
			}
		}
		// If the installation is already intact (e.g. update finished before journal truncation,
		// or the user explicitly ran `muvloom skill install` afterward), do NOT roll it back;
		// simply clear the stale journal.
		if isAlreadyIntactInstall(journal.Destination) {
			_ = os.Truncate(jPath, 0)
			release()
			continue
		}
		if restoreFromJournal(journal, false) == nil {
			_ = os.Truncate(jPath, 0)
		}
		release()
	}
}

func isAlreadyIntactInstall(dest string) bool {
	info, err := os.Lstat(dest)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	metaBytes, err := os.ReadFile(filepath.Join(dest, ".muvloom-skill.json"))
	if err != nil {
		return false
	}
	var meta metadata
	if err := json.Unmarshal(metaBytes, &meta); err != nil || meta.Skill != "muvloom" || meta.FileHash == "" {
		return false
	}
	onDisk, err := treeHash(dest)
	return err == nil && onDisk == meta.FileHash
}

// restoreFromJournal safely rolls a Skill directory back to journal.Snapshot.
// In startup recovery mode (inProcess == false), it strictly validates destination/ancestor
// symlink boundaries, refuses any symlink anywhere inside destination, verifies the on-disk
// metadata still belongs to this transaction's FromHash, and refuses to delete any unexpected
// user-added file outside journal.Planned and journal.Snapshot.
func restoreFromJournal(journal updateJournal, inProcess bool) error {
	dest := journal.Destination
	// 1. Validate destination and (for project scope) ancestor symlink boundaries.
	if journal.Root != "" && journal.Scope != "" {
		if err := checkDestination(journal.Scope, journal.Root, dest); err != nil {
			return err
		}
	} else {
		info, err := os.Lstat(dest)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("destination is missing or a symlink")
		}
	}

	// 2. Validate every path recorded in the journal so a tampered journal cannot escape dest.
	for _, plannedRel := range journal.Planned {
		if !isSafeRelativeSkillPath(plannedRel) {
			return fmt.Errorf("unsafe planned path %q in journal", plannedRel)
		}
	}
	for snapRel := range journal.Snapshot {
		if snapRel != ".muvloom-skill.json" && !isSafeRelativeSkillPath(snapRel) {
			return fmt.Errorf("unsafe snapshot path %q in journal", snapRel)
		}
	}

	// 3. In startup recovery, confirm metadata still matches FromHash (never roll back an
	// unrelated reinstall) and ensure no symlinks or user-added files exist inside dest.
	plannedSet := make(map[string]struct{}, len(journal.Planned))
	for _, p := range journal.Planned {
		plannedSet[p] = struct{}{}
	}
	if !inProcess {
		if journal.FromHash != "" {
			if curMetaBytes, err := os.ReadFile(filepath.Join(dest, ".muvloom-skill.json")); err == nil {
				var curMeta metadata
				if json.Unmarshal(curMetaBytes, &curMeta) == nil && curMeta.FileHash != "" && curMeta.FileHash != journal.FromHash {
					return errors.New("destination metadata does not match journal transaction")
				}
			}
		}
	}

	var hasSymlink bool
	var hasUnexpectedUserFile bool
	walkErr := filepath.WalkDir(dest, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dest {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			hasSymlink = true
			return fs.SkipAll
		}
		if entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(dest, p)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if !inProcess {
			_, inSnap := journal.Snapshot[rel]
			_, inPlanned := plannedSet[rel]
			if !inSnap && !inPlanned {
				hasUnexpectedUserFile = true
				return fs.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil {
		return walkErr
	}
	if hasSymlink {
		return errors.New("refusing to recover through a symlink inside Skill directory")
	}
	if hasUnexpectedUserFile {
		return errors.New("refusing to overwrite unexpected user file during recovery")
	}

	// 4. Remove ONLY files created/planned by this transaction that are not in Snapshot,
	// checking symlink boundaries before every delete.
	snapFolded := map[string]string{}
	snapDirFolded := map[string]string{}
	for rel := range journal.Snapshot {
		snapFolded[strings.ToLower(rel)] = rel
		for _, d := range parentDirs(rel) {
			snapDirFolded[strings.ToLower(d)] = d
		}
	}
	var cleanupDirs []string
	for _, plannedRel := range journal.Planned {
		if _, inSnap := journal.Snapshot[plannedRel]; inSnap {
			continue
		}
		target := filepath.Join(dest, filepath.FromSlash(plannedRel))
		if _, statErr := os.Lstat(target); statErr != nil {
			continue
		}
		if err := refuseSymlinks(dest, target); err != nil {
			return err
		}
		_ = os.Remove(target)
		cleanupDirs = append(cleanupDirs, parentDirs(plannedRel)...)
	}
	// Remove any directories created for planned files that conflict with snapshot files or dir casing.
	for _, plannedRel := range journal.Planned {
		for _, d := range parentDirs(plannedRel) {
			if _, fileWantsPath := snapFolded[strings.ToLower(d)]; fileWantsPath {
				cleanupDirs = append(cleanupDirs, d)
			}
			if snapDir, ok := snapDirFolded[strings.ToLower(d)]; ok && snapDir != d {
				cleanupDirs = append(cleanupDirs, d)
			}
		}
	}
	pruneDirsDeepestFirst(dest, cleanupDirs)

	// 5. Restore snapshot files in place, checking symlink boundaries before every write.
	for rel, data := range journal.Snapshot {
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if err := refuseSymlinks(dest, target); err != nil {
			return err
		}
		if err := writeSkillFileInPlace(target, data); err != nil {
			return err
		}
	}
	if metaBytes, ok := journal.Snapshot[".muvloom-skill.json"]; ok {
		var meta metadata
		if json.Unmarshal(metaBytes, &meta) == nil && meta.FileHash != "" {
			if got, err := treeHash(dest); err != nil || got != meta.FileHash {
				return errors.New("restored Skill tree did not match snapshot hash")
			}
		}
	}
	return nil
}

func parentDirs(rel string) []string {
	var dirs []string
	cur := path.Dir(rel)
	for cur != "." && cur != "/" && cur != "" {
		dirs = append(dirs, cur)
		cur = path.Dir(cur)
	}
	return dirs
}

func pruneDirsDeepestFirst(root string, dirs []string) {
	if len(dirs) == 0 {
		return
	}
	seen := map[string]struct{}{}
	unique := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if d == "" || d == "." || d == "/" {
			continue
		}
		if _, dup := seen[d]; dup {
			continue
		}
		seen[d] = struct{}{}
		unique = append(unique, d)
	}
	sort.Slice(unique, func(i, j int) bool { return len(unique[i]) > len(unique[j]) })
	for _, d := range unique {
		_ = os.Remove(filepath.Join(root, filepath.FromSlash(d)))
	}
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
