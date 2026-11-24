package updates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/netidle"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

const (
	// SelfAutoUpdateBudget bounds the total wall-clock time MaybeAutoUpdateSelf may spend
	// inside auth status so normal commands never stall on slow networks.
	SelfAutoUpdateBudget = 8 * time.Second
	selfAutoLockWait     = 500 * time.Millisecond
	selfCheckInterval    = 24 * time.Hour
)

var (
	ErrSelfUnsupportedService  = errors.New("unsupported service for CLI self-update")
	ErrSelfUnsupportedPlatform = errors.New("no CLI binary published for this platform")
	ErrSelfRemoteUnavailable   = errors.New("remote CLI manifest or binary unavailable")
	ErrSelfInvalidBinary       = errors.New("CLI binary failed integrity verification")
	ErrSelfUpdateBusy          = errors.New("another CLI self-update is in progress")
	errSelfBinaryNotFound      = errors.New("CLI binary path returned 404")
)

func SelfErrorReason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrSelfUnsupportedService):
		return "unsupported service"
	case errors.Is(err, ErrSelfUnsupportedPlatform):
		return "unsupported platform"
	case errors.Is(err, ErrSelfUpdateBusy), errors.Is(err, auth.ErrLockTimeout):
		return "another muvloom process is updating"
	case errors.Is(err, netidle.ErrStalled):
		return "download stalled"
	case errors.Is(err, ErrSelfRemoteUnavailable):
		return "network or service error"
	case errors.Is(err, ErrSelfInvalidBinary):
		return "verification failed"
	case errors.Is(err, os.ErrPermission):
		return "permission denied"
	default:
		return "storage error"
	}
}

type SelfUpdateOptions struct {
	StateDir       string
	CurrentVersion string
	ExecutablePath string
	OS             string
	Arch           string
	APIURL         string
	BaseURL        string
	HTTP           *http.Client
	Now            func() time.Time
}

type SelfUpdateResult struct {
	Status         string `json:"status"` // up_to_date, update_available, updated, skipped, disabled, unavailable
	AutoUpdate     bool   `json:"auto_update"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version,omitempty"`
	InstallPath    string `json:"install_path,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

type selfUpdateState struct {
	AutoUpdate        *bool     `json:"auto_update,omitempty"`
	LastCheckedAt     time.Time `json:"last_checked_at,omitempty"`
	LastRemoteVersion string    `json:"last_remote_version,omitempty"`
	LastUpdatedAt     time.Time `json:"last_updated_at,omitempty"`
}

func selfStatePath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "self-update.json")
}

func selfLockPath(stateDir string) string {
	return filepath.Join(stateDir, "updates", "self-update.lock")
}

func readSelfState(stateDir string) (selfUpdateState, error) {
	if stateDir == "" {
		return selfUpdateState{}, nil
	}
	path := selfStatePath(stateDir)
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(20 * time.Millisecond)
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return selfUpdateState{}, nil
		}
		if err != nil {
			lastErr = err
			continue
		}
		if len(bytes.TrimSpace(data)) == 0 {
			return selfUpdateState{}, nil
		}
		var state selfUpdateState
		if uErr := json.Unmarshal(data, &state); uErr == nil {
			return state, nil
		} else {
			lastErr = uErr
		}
	}
	return selfUpdateState{}, lastErr
}

func writeSelfState(stateDir string, state selfUpdateState) error {
	if stateDir == "" {
		return nil
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return auth.WriteFileInPlace(selfStatePath(stateDir), data)
}

// SelfAutoUpdateEnabled reports whether automatic 24h silent CLI self-updates are enabled.
// Missing state defaults to enabled; unreadable or corrupted state fails closed (returns false)
// so a storage/parse fault never overrides a prior `--auto off` preference.
func SelfAutoUpdateEnabled(stateDir string) bool {
	state, err := readSelfState(stateDir)
	if err != nil {
		return false
	}
	return state.AutoUpdate == nil || *state.AutoUpdate
}

// SetSelfAutoUpdate persists the user's automatic CLI self-update preference in place.
func SetSelfAutoUpdate(stateDir string, enabled bool) error {
	if stateDir == "" {
		return errors.New("state directory is required")
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "updates"), 0o700); err != nil {
		return err
	}
	release, err := auth.LockFile(selfLockPath(stateDir), 2*time.Second)
	if err != nil {
		return err
	}
	defer release()
	state, _ := readSelfState(stateDir)
	val := enabled
	state.AutoUpdate = &val
	if enabled {
		state.LastCheckedAt = time.Time{}
	}
	return writeSelfState(stateDir, state)
}

func windowsOldBackupPath(exePath string) string {
	return filepath.Join(filepath.Dir(exePath), "."+filepath.Base(exePath)+".muvloom-old")
}

// CleanStaleOldBinary heals an interrupted Windows self-update (restoring `.<exe>.muvloom-old`
// when `<exe>` is missing) or removes the updater's own leftover backup once `<exe>` is intact.
// It is a no-op on non-Windows platforms and never touches user-named `<exe>.old` backups.
func CleanStaleOldBinary(executablePath string) {
	cleanOrHealWindowsOldBinary(executablePath, runtime.GOOS)
}

func cleanOrHealWindowsOldBinary(executablePath, goos string) {
	if goos != "windows" || executablePath == "" {
		return
	}
	oldPath := windowsOldBackupPath(executablePath)
	if _, exeErr := os.Stat(executablePath); errors.Is(exeErr, os.ErrNotExist) {
		if _, oldErr := os.Stat(oldPath); oldErr == nil {
			_ = os.Rename(oldPath, executablePath)
		}
		return
	} else if exeErr == nil {
		_ = os.Remove(oldPath)
	}
}

func resolveTargetExecutable(explicit string, allowTestBinary bool) (string, bool) {
	exe := strings.TrimSpace(explicit)
	if exe == "" {
		found, err := os.Executable()
		if err != nil {
			return "", false
		}
		exe = found
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if !allowTestBinary {
		lower := strings.ToLower(filepath.Base(exe))
		if strings.HasSuffix(lower, ".test") || strings.HasSuffix(lower, ".test.exe") {
			return "", false
		}
	}
	return exe, true
}

// MaybeAutoUpdateSelf performs a best-effort, 24h-throttled silent self-update of the CLI
// binary from Muvloom's official web manifest. It never blocks or fails the caller's command.
func MaybeAutoUpdateSelf(ctx context.Context, opts SelfUpdateOptions) SelfUpdateResult {
	curVer := strings.TrimPrefix(opts.CurrentVersion, "v")
	if opts.StateDir == "" {
		return SelfUpdateResult{Status: "skipped", AutoUpdate: true, CurrentVersion: curVer, Reason: "no_state_dir"}
	}
	initState, initErr := readSelfState(opts.StateDir)
	if initErr != nil {
		return SelfUpdateResult{Status: "unavailable", AutoUpdate: false, CurrentVersion: curVer, Reason: "state_unreadable"}
	}
	if initState.AutoUpdate != nil && !*initState.AutoUpdate {
		return SelfUpdateResult{Status: "disabled", AutoUpdate: false, CurrentVersion: curVer}
	}
	exe, ok := resolveTargetExecutable(opts.ExecutablePath, strings.TrimSpace(opts.ExecutablePath) != "")
	if !ok {
		return SelfUpdateResult{Status: "skipped", AutoUpdate: true, CurrentVersion: curVer, Reason: "non_updatable_binary"}
	}
	goos := opts.OS
	if goos == "" {
		goos = runtime.GOOS
	}
	origin, ok := skill.ResolveManifestOrigin(opts.APIURL, opts.BaseURL)
	if !ok {
		return SelfUpdateResult{Status: "skipped", AutoUpdate: true, CurrentVersion: curVer, Reason: "unrecognized_origin"}
	}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, SelfAutoUpdateBudget)
		defer cancel()
	}
	if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
		return SelfUpdateResult{Status: "unavailable", AutoUpdate: true, CurrentVersion: curVer, Reason: "storage_unavailable"}
	}
	release, err := auth.LockFile(selfLockPath(opts.StateDir), selfAutoLockWait)
	if err != nil {
		return SelfUpdateResult{Status: "skipped", AutoUpdate: true, CurrentVersion: curVer, Reason: "check_in_progress"}
	}
	defer release()
	cleanOrHealWindowsOldBinary(exe, goos)

	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	state, stateErr := readSelfState(opts.StateDir)
	if stateErr != nil {
		return SelfUpdateResult{Status: "unavailable", AutoUpdate: false, CurrentVersion: curVer, Reason: "state_unreadable"}
	}
	if state.AutoUpdate != nil && !*state.AutoUpdate {
		return SelfUpdateResult{Status: "disabled", AutoUpdate: false, CurrentVersion: curVer}
	}
	if !state.LastCheckedAt.IsZero() && !now.Before(state.LastCheckedAt) && now.Sub(state.LastCheckedAt) < selfCheckInterval {
		return SelfUpdateResult{
			Status:         "skipped",
			AutoUpdate:     true,
			CurrentVersion: curVer,
			LatestVersion:  state.LastRemoteVersion,
			Reason:         "throttled",
		}
	}
	if ctx.Err() != nil {
		return SelfUpdateResult{Status: "unavailable", AutoUpdate: true, CurrentVersion: curVer, Reason: "check_or_update_failed"}
	}

	opts.ExecutablePath = exe
	res, err := runSelfUpdate(ctx, opts, origin, exe, false, true, &state, now)
	if err != nil {
		// Transient failure uses a 5-minute retry cooldown instead of locking out updates for 24h.
		state.LastCheckedAt = now.Add(-selfCheckInterval + 5*time.Minute)
		_ = writeSelfState(opts.StateDir, state)
		if errors.Is(err, os.ErrPermission) {
			return SelfUpdateResult{Status: "skipped", AutoUpdate: true, CurrentVersion: curVer, Reason: "permission_denied"}
		}
		return SelfUpdateResult{Status: "unavailable", AutoUpdate: true, CurrentVersion: curVer, Reason: "check_or_update_failed"}
	}
	state.LastCheckedAt = now
	_ = writeSelfState(opts.StateDir, state)
	return res
}

// CheckOrUpdateSelf explicitly checks or updates the CLI binary from Muvloom's official
// web manifest, bypassing the 24h throttle and auto_update toggle.
func CheckOrUpdateSelf(ctx context.Context, opts SelfUpdateOptions, checkOnly bool) (SelfUpdateResult, error) {
	origin, ok := skill.ResolveManifestOrigin(opts.APIURL, opts.BaseURL)
	if !ok {
		return SelfUpdateResult{}, ErrSelfUnsupportedService
	}
	now := time.Now()
	if opts.Now != nil {
		now = opts.Now()
	}
	autoEnabled := SelfAutoUpdateEnabled(opts.StateDir)
	exe, hasExe := resolveTargetExecutable(opts.ExecutablePath, strings.TrimSpace(opts.ExecutablePath) != "")
	if checkOnly {
		return runSelfUpdate(ctx, opts, origin, exe, true, autoEnabled, nil, now)
	}
	if !hasExe {
		return SelfUpdateResult{}, errors.New("could not determine current executable path")
	}
	goos := opts.OS
	if goos == "" {
		goos = runtime.GOOS
	}
	var release func()
	var statePtr *selfUpdateState
	lockTarget := filepath.Join(filepath.Dir(exe), ".muvloom-self-update.lock")
	if opts.StateDir != "" {
		if err := os.MkdirAll(filepath.Join(opts.StateDir, "updates"), 0o700); err != nil {
			return SelfUpdateResult{}, err
		}
		lockTarget = selfLockPath(opts.StateDir)
	}
	unlock, err := auth.LockFile(lockTarget, 2*time.Second)
	if err != nil {
		if errors.Is(err, auth.ErrLockTimeout) {
			return SelfUpdateResult{}, fmt.Errorf("%w: %w", ErrSelfUpdateBusy, err)
		}
		return SelfUpdateResult{}, err
	}
	release = unlock
	defer release()
	cleanOrHealWindowsOldBinary(exe, goos)
	if opts.StateDir != "" {
		if state, sErr := readSelfState(opts.StateDir); sErr == nil {
			autoEnabled = state.AutoUpdate == nil || *state.AutoUpdate
			state.LastCheckedAt = now
			statePtr = &state
		}
	}
	return runSelfUpdate(ctx, opts, origin, exe, false, autoEnabled, statePtr, now)
}

func runSelfUpdate(
	ctx context.Context,
	opts SelfUpdateOptions,
	origin string,
	exePath string,
	checkOnly bool,
	autoEnabled bool,
	state *selfUpdateState,
	now time.Time,
) (SelfUpdateResult, error) {
	curStr := strings.TrimPrefix(opts.CurrentVersion, "v")
	curVer, curOK := parseVersion(curStr)
	if !curOK {
		return SelfUpdateResult{}, fmt.Errorf("invalid current CLI version %q", opts.CurrentVersion)
	}
	manifest, err := skill.FetchManifest(ctx, opts.HTTP, origin)
	if err != nil {
		if errors.Is(err, skill.ErrInvalidManifest) {
			return SelfUpdateResult{}, fmt.Errorf("%w: %w", ErrSelfInvalidBinary, err)
		}
		return SelfUpdateResult{}, fmt.Errorf("%w: %w", ErrSelfRemoteUnavailable, err)
	}
	if manifest.CLI == nil {
		return SelfUpdateResult{}, fmt.Errorf("%w: manifest does not include CLI binaries", ErrSelfRemoteUnavailable)
	}
	remoteVer, remoteOK := parseVersion(manifest.CLI.Version)
	if !remoteOK {
		return SelfUpdateResult{}, fmt.Errorf("%w: invalid remote CLI version", ErrSelfInvalidBinary)
	}
	if state != nil && opts.StateDir != "" {
		state.LastRemoteVersion = remoteVer.String()
		_ = writeSelfState(opts.StateDir, *state)
	}

	goos := opts.OS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := opts.Arch
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	platformKey := goos + "/" + goarch
	binEntry, supported := manifest.CLI.Binaries[platformKey]
	if !supported {
		return SelfUpdateResult{}, ErrSelfUnsupportedPlatform
	}

	if !curVer.less(remoteVer) {
		return SelfUpdateResult{
			Status:         "up_to_date",
			AutoUpdate:     autoEnabled,
			CurrentVersion: curVer.String(),
			LatestVersion:  remoteVer.String(),
			InstallPath:    exePath,
		}, nil
	}
	if checkOnly {
		return SelfUpdateResult{
			Status:         "update_available",
			AutoUpdate:     autoEnabled,
			CurrentVersion: curVer.String(),
			LatestVersion:  remoteVer.String(),
			InstallPath:    exePath,
		}, nil
	}

	data, err := downloadVerifiedBinary(ctx, opts.HTTP, origin+"/cli/"+binEntry.Path, binEntry.Bytes, binEntry.SHA256)
	if errors.Is(err, errSelfBinaryNotFound) {
		// A concurrent web deploy may have rotated /cli/skill-manifest.json and its content-hashed
		// binary path between the manifest fetch and binary download: re-fetch the manifest once.
		if refreshed, mErr := skill.FetchManifest(ctx, opts.HTTP, origin); mErr == nil && refreshed.CLI != nil {
			if refreshedVer, rOK := parseVersion(refreshed.CLI.Version); rOK && curVer.less(refreshedVer) {
				if nextEntry, nextOK := refreshed.CLI.Binaries[platformKey]; nextOK {
					remoteVer = refreshedVer
					binEntry = nextEntry
					if state != nil && opts.StateDir != "" {
						state.LastRemoteVersion = remoteVer.String()
					}
					data, err = downloadVerifiedBinary(ctx, opts.HTTP, origin+"/cli/"+binEntry.Path, binEntry.Bytes, binEntry.SHA256)
				}
			}
		}
	}
	if err != nil {
		return SelfUpdateResult{}, err
	}
	if err := replaceExecutableAtomically(exePath, data, goos); err != nil {
		return SelfUpdateResult{}, err
	}
	if state != nil && opts.StateDir != "" {
		state.LastUpdatedAt = now
		_ = writeSelfState(opts.StateDir, *state)
	}
	return SelfUpdateResult{
		Status:         "updated",
		AutoUpdate:     autoEnabled,
		CurrentVersion: curVer.String(),
		LatestVersion:  remoteVer.String(),
		InstallPath:    exePath,
	}, nil
}

func downloadVerifiedBinary(ctx context.Context, base *http.Client, targetURL string, expectedBytes int, expectedSHA256 string) ([]byte, error) {
	if expectedBytes <= 0 || expectedBytes > skill.MaxCLIBinaryBytes {
		return nil, fmt.Errorf("%w: invalid expected binary size", ErrSelfInvalidBinary)
	}
	httpClient := &http.Client{CheckRedirect: client.NoRedirects}
	if base != nil {
		httpClient.Transport = base.Transport
	}
	// No total limit: a slow link that keeps moving bytes finishes. The automatic update in
	// auth status still has its own budget through ctx.
	ctx, cancel := context.WithTimeout(ctx, selfBinaryMaxTotal) // a floor: a byte every few seconds never finishes
	defer cancel()
	fetch := netidle.Start(ctx, httpClient, selfBinaryIdle, false)
	defer fetch.Stop()
	req, err := http.NewRequestWithContext(fetch.Ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrSelfRemoteUnavailable, err)
	}
	resp, err := fetch.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrSelfRemoteUnavailable, stallCause(fetch, err))
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: %w", ErrSelfRemoteUnavailable, errSelfBinaryNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: unexpected HTTP status %d", ErrSelfRemoteUnavailable, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(expectedBytes)+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrSelfRemoteUnavailable, stallCause(fetch, err))
	}
	if len(data) != expectedBytes {
		return nil, fmt.Errorf("%w: binary byte count mismatch", ErrSelfInvalidBinary)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expectedSHA256 {
		return nil, fmt.Errorf("%w: binary SHA-256 mismatch", ErrSelfInvalidBinary)
	}
	return data, nil
}

func replaceExecutableAtomically(exePath string, data []byte, goos string) error {
	dir := filepath.Dir(exePath)
	tmpFile, err := os.CreateTemp(dir, ".muvloom-self-*")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmpPath)
		}
	}()
	if goos != "windows" {
		if err := tmpFile.Chmod(0o755); err != nil {
			_ = tmpFile.Close()
			return err
		}
	}
	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if goos == "windows" {
		oldPath := windowsOldBackupPath(exePath)
		_ = os.Remove(oldPath)
		if _, statErr := os.Stat(exePath); statErr == nil {
			if err := os.Rename(exePath, oldPath); err != nil {
				return err
			}
			if err := os.Rename(tmpPath, exePath); err != nil {
				_ = os.Rename(oldPath, exePath)
				return err
			}
			renamed = true
			_ = os.Remove(oldPath)
			return nil
		}
	}
	if err := os.Rename(tmpPath, exePath); err != nil {
		return err
	}
	renamed = true
	return nil
}

// stallCause names a stall instead of the bare context error it caused.
func stallCause(t *netidle.Transfer, err error) error {
	if t.Stalled() {
		return fmt.Errorf("%w: nothing moved for %s", netidle.ErrStalled, t.Window())
	}
	return err
}

// selfBinaryIdle: no bytes moved for this long ends the download. A variable so tests can shorten it.
var selfBinaryIdle = 30 * time.Second

// selfBinaryMaxTotal bounds an explicit `update self` download that keeps trickling.
const selfBinaryMaxTotal = 10 * time.Minute
