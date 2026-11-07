// Package auth persists CLI credentials. The platform credential store (macOS Keychain,
// Windows Credential Manager, Linux Secret Service) is used when available; otherwise a
// 0600 file under the user config directory. Credential values are never logged.
//
// Files are only ever created and written in place: never renamed over, never deleted during
// a login, a refresh or a logout. An agent host that sandboxes the config directory asks the
// user before deleting or replacing a file, and a background command cannot be asked. A
// signed-out file is emptied instead, and an empty file reads as "nothing stored".
package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "muvloom-cli"
	keyringUser    = "default"
	// keyringProbeUser is a throwaway entry Preflight writes; it never holds a secret.
	keyringProbeUser = "write-check"
)

// ErrNotFound means no credentials are stored.
var ErrNotFound = errors.New("no stored credentials")

// ErrLockTimeout means another muvloom process held the credential lock for the whole wait.
// Any other Lock error is a storage problem, not contention.
var ErrLockTimeout = errors.New("timed out waiting for another muvloom process to refresh credentials")

// Keychain is the system credential store. Tests substitute one.
type Keychain interface {
	Get(service, user string) (string, error)
	Set(service, user, secret string) error
	Delete(service, user string) error
}

type systemKeychain struct{}

func (systemKeychain) Get(service, user string) (string, error) { return keyring.Get(service, user) }
func (systemKeychain) Set(service, user, secret string) error {
	return keyring.Set(service, user, secret)
}
func (systemKeychain) Delete(service, user string) error { return keyring.Delete(service, user) }

type Credentials struct {
	AccessToken         string    `json:"access_token"`
	RefreshToken        string    `json:"refresh_token"`
	AccessExpiresAt     time.Time `json:"access_expires_at"`
	RefreshExpiresAt    time.Time `json:"refresh_expires_at"`
	BaseURL             string    `json:"base_url"`
	LoginDeviceCodeHash string    `json:"login_device_code_hash,omitempty"`
	// RefreshRequestID is saved before a refresh is sent and cleared with the tokens it
	// returns. A retry after a lost response carries it, and the server answers with the
	// same tokens instead of treating the old refresh token as copied.
	RefreshRequestID string `json:"refresh_request_id,omitempty"`
}

// PendingLogin is a device authorization that has been started but not yet approved.
type PendingLogin struct {
	DeviceCode              string    `json:"device_code"`
	UserCode                string    `json:"user_code"`
	VerificationURIComplete string    `json:"verification_uri_complete"`
	ExpiresAt               time.Time `json:"expires_at"`
	IntervalSeconds         int       `json:"interval_seconds"`
	BaseURL                 string    `json:"base_url"`
	// RequestID goes with every redemption of the device code, so a redemption whose
	// tokens never reached the credential store can be repeated for the same tokens.
	RequestID string `json:"request_id,omitempty"`
	// Redeemed records that the server already issued tokens for this code. The next login
	// redeems it again with RequestID, even after the code itself expired.
	Redeemed bool `json:"redeemed,omitempty"`
}

type Store struct {
	Dir string
	// UseKeyring stores credentials in the platform credential store when it works.
	UseKeyring bool
	// ClearKeyring makes Clear remove the keychain entry even when this process stores to
	// a file, so switching MUVLOOM_CREDENTIALS_STORE cannot leave a login behind. Tests that
	// build a Store directly leave it off and never touch the real keychain.
	ClearKeyring bool
	// Keychain replaces the system credential store; nil means the system's.
	Keychain Keychain
}

func (s Store) keychain() Keychain {
	if s.Keychain != nil {
		return s.Keychain
	}
	return systemKeychain{}
}

// ConfigDir is $MUVLOOM_CONFIG_DIR, or <user config dir>/muvloom.
func ConfigDir() string {
	if dir := os.Getenv("MUVLOOM_CONFIG_DIR"); dir != "" {
		return dir
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "muvloom")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".config", "muvloom")
	}
	return ".muvloom"
}

// Default uses the keyring unless MUVLOOM_CREDENTIALS_STORE=file.
func Default() Store {
	return Store{
		Dir:          ConfigDir(),
		UseKeyring:   os.Getenv("MUVLOOM_CREDENTIALS_STORE") != "file",
		ClearKeyring: true,
	}
}

func (s Store) credentialsFile() string { return filepath.Join(s.Dir, "credentials.json") }
func (s Store) pendingFile() string     { return filepath.Join(s.Dir, "pending-login.json") }
func (s Store) serviceFile() string     { return filepath.Join(s.Dir, "connection.json") }
func (s Store) lockFile() string        { return filepath.Join(s.Dir, "credentials.lock") }

// Info says where credentials live and, when the keychain is wanted but unusable, why. The
// reason is a stable word: the keychain's own error text can carry local details.
type Info struct {
	Backend       string // keychain, file or none
	KeychainIssue string // "", unavailable or unsupported_platform
}

// Describe reports the storage for `auth status`.
func (s Store) Describe() Info {
	var info Info
	if s.UseKeyring {
		_, err := s.keychain().Get(keyringService, keyringUser)
		switch {
		case err == nil:
			info.Backend = "keychain"
			return info
		case errors.Is(err, keyring.ErrNotFound):
			// The keychain works; it just holds nothing yet.
		case errors.Is(err, keyring.ErrUnsupportedPlatform):
			info.KeychainIssue = "unsupported_platform"
		default:
			info.KeychainIssue = "unavailable"
		}
	}
	if fileHasContent(s.credentialsFile()) {
		info.Backend = "file"
	} else {
		info.Backend = "none"
	}
	return info
}

func (s Store) Load() (Credentials, error) {
	if s.UseKeyring {
		if secret, err := s.keychain().Get(keyringService, keyringUser); err == nil {
			var creds Credentials
			if err := json.Unmarshal([]byte(secret), &creds); err != nil {
				return Credentials{}, fmt.Errorf("stored credentials are unreadable: %w", err)
			}
			return creds, nil
		}
	}
	var creds Credentials
	err := readRecord(s.credentialsFile(), &creds)
	return creds, err
}

// Save stores the credentials and, beside them, which service they belong to. The service
// address is not a secret: keeping it apart means an unreadable keychain or credential file
// never makes the CLI guess the service.
func (s Store) Save(creds Credentials) error {
	return s.locked(func() error {
		if err := s.saveSecret(creds); err != nil {
			return err
		}
		s.saveService(creds.BaseURL)
		return nil
	})
}

func (s Store) saveSecret(creds Credentials) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	if s.UseKeyring {
		if err := s.keychain().Set(keyringService, keyringUser, string(data)); err == nil {
			// The keychain now holds the login. Emptying the old file copy is housekeeping: its
			// failure must not turn a stored login into a reported failure.
			_ = truncateIfExists(s.credentialsFile())
			return nil
		}
	}
	// Write the file before touching the keychain: if the write fails, the previous
	// credentials must still be somewhere.
	if err := writeRecord(s.credentialsFile(), creds); err != nil {
		return err
	}
	// Load prefers the keychain, so an older entry there would shadow the file and replay
	// a retired refresh token. This also covers MUVLOOM_CREDENTIALS_STORE=file.
	if s.UseKeyring || s.ClearKeyring {
		if err := s.keychain().Delete(keyringService, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			if _, getErr := s.keychain().Get(keyringService, keyringUser); getErr == nil {
				return fmt.Errorf("the system keychain still holds older credentials: %w", err)
			}
		}
	}
	return nil
}

// State files (credentials, pending login, service) are JSON objects carrying a "checksum"
// member: a SHA-256 over the object's other members, computed on the raw members so that a
// field added later never invalidates a record. A record cut short by a crash, torn by a
// concurrent writer or edited by hand fails the check instead of being half trusted. The
// member names are unchanged, so an older CLI still reads the files. A file without a checksum
// is an older record and is accepted as it is.

func checksumOf(members map[string]json.RawMessage) string {
	data, _ := json.Marshal(members) // sorted keys, compacted values: the same bytes every time
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func frame(v any) ([]byte, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil {
		return nil, err
	}
	members["checksum"] = json.RawMessage(strconv.Quote(checksumOf(members)))
	return json.Marshal(members)
}

// ErrIntegrity means a stored record did not match its own checksum.
var ErrIntegrity = errors.New("failed its integrity check")

func unframe(data []byte, out any) error {
	var members map[string]json.RawMessage
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&members); err != nil {
		return err
	}
	if raw, ok := members["checksum"]; ok {
		delete(members, "checksum")
		var want string
		if json.Unmarshal(raw, &want) != nil || want != checksumOf(members) {
			return ErrIntegrity
		}
	}
	payload, err := json.Marshal(members)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, out)
}

func writeRecord(path string, v any) error {
	data, err := frame(v)
	if err != nil {
		return err
	}
	return WriteFileInPlace(path, data)
}

// readRecord reads a record another process may be writing at this moment: an in-place write
// is briefly a prefix of the new record, or the new record followed by the tail of a longer old
// one. A few short retries ride that out; a record that stays bad is reported, never used.
func readRecord(path string, out any) error {
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(25 * time.Millisecond)
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(data)) == 0 {
			return ErrNotFound
		}
		if err := unframe(data, out); err != nil {
			if errors.Is(err, ErrIntegrity) {
				lastErr = fmt.Errorf("%s %w", filepath.Base(path), err)
			} else {
				lastErr = fmt.Errorf("%s is unreadable: %w", filepath.Base(path), err)
			}
			continue
		}
		return nil
	}
	return lastErr
}

// saveService is best effort: the connection works without it.
func (s Store) saveService(baseURL string) {
	if baseURL == "" {
		return
	}
	_ = writeRecord(s.serviceFile(), map[string]string{"base_url": baseURL})
}

// LoadService returns the service the stored connection belongs to, without reading any
// secret. ErrNotFound means none is recorded.
func (s Store) LoadService() (string, error) {
	var record struct {
		BaseURL string `json:"base_url"`
	}
	if err := readRecord(s.serviceFile(), &record); err != nil {
		return "", err
	}
	if record.BaseURL == "" {
		return "", ErrNotFound
	}
	return record.BaseURL, nil
}

// Clear signs out of every backend, whichever one this process is using, so switching
// MUVLOOM_CREDENTIALS_STORE cannot leave a login behind. Files are emptied, not deleted.
func (s Store) Clear() error {
	return s.locked(func() error {
		var keyringErr error
		if s.UseKeyring || s.ClearKeyring {
			_ = s.keychain().Delete(keyringService, keyringProbeUser)
			if err := s.keychain().Delete(keyringService, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
				// An unavailable keychain is only a problem if it still holds our entry.
				if _, getErr := s.keychain().Get(keyringService, keyringUser); getErr == nil {
					keyringErr = fmt.Errorf("could not remove credentials from the system keychain: %w", err)
				}
			}
		}
		return errors.Join(keyringErr, truncateIfExists(s.credentialsFile()), truncateIfExists(s.pendingFile()), truncateIfExists(s.serviceFile()))
	})
}

// Preflight checks, before a login redeems its one-time device code, that Save will be able to
// store what comes back: the keychain takes an entry, or the credential file can be written,
// updated and emptied in place. It writes no secret and leaves stored credentials as they were.
func (s Store) Preflight() error {
	return s.locked(func() error {
		if s.UseKeyring {
			kc := s.keychain()
			if err := kc.Set(keyringService, keyringProbeUser, "ok"); err == nil {
				_ = kc.Delete(keyringService, keyringProbeUser)
				return nil
			}
		}
		return probeFile(s.credentialsFile())
	})
}

func probeFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Rewriting the record with its own bytes is the in-place write a save makes; an empty or
	// missing file is opened for writing and left empty, so nothing ever reads as stored.
	return WriteFileInPlace(path, data)
}

func (s Store) LoadPending() (PendingLogin, error) {
	var pending PendingLogin
	err := readRecord(s.pendingFile(), &pending)
	return pending, err
}

func (s Store) SavePending(pending PendingLogin) error {
	return s.locked(func() error { return writeRecord(s.pendingFile(), pending) })
}

func (s Store) ClearPending() error {
	return s.locked(func() error { return truncateIfExists(s.pendingFile()) })
}

func fileHasContent(path string) bool {
	data, err := os.ReadFile(path)
	return err == nil && len(bytes.TrimSpace(data)) > 0
}

// truncateIfExists empties a file without deleting it.
func truncateIfExists(path string) error {
	if err := os.Truncate(path, 0); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// WriteFileInPlace writes data into path, readable only by the current user. The file is
// created if missing and otherwise keeps its identity: no temporary file, no rename.
func WriteFileInPlace(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := file.Chmod(0o600); err != nil {
			file.Close()
			return err
		}
	}
	// Write first, shorten after: the file never holds less than the new record.
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

// Leftovers lists the temporary files earlier versions left in the config directory when a
// rename was refused. Only our own `.tmp-*` files count.
func (s Store) Leftovers() []string {
	var found []string
	for _, dir := range []string{s.Dir, filepath.Join(s.Dir, "submissions"), filepath.Join(s.Dir, "updates")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), ".tmp-") {
				found = append(found, filepath.Join(dir, entry.Name()))
			}
		}
	}
	return found
}

// CleanupLeftovers removes them. Deleting is what a sandbox asks about, so callers use it only
// for an explicit request; failing to remove one is not an error, it is housekeeping.
func (s Store) CleanupLeftovers() {
	for _, path := range s.Leftovers() {
		_ = os.Remove(path)
	}
}

// Reason names why a storage operation failed in a few stable words. The error text of the
// filesystem or the keychain can carry local paths and details, and is never shown.
func Reason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrIntegrity):
		return "failed its integrity check"
	case errors.Is(err, ErrNotFound):
		return "nothing is stored"
	case errors.Is(err, os.ErrPermission):
		return "permission denied"
	case errors.Is(err, ErrLockTimeout):
		return "another muvloom process is writing"
	default:
		return "storage error"
	}
}

// legacyLockStaleAfter is how long an older version (0.1.3 and earlier) waited before it
// treated a lock file it did not own as left by a dead process.
const legacyLockStaleAfter = 5 * time.Minute

// Lock serializes credential refresh across concurrent CLI processes, so two processes never
// present the same refresh token (a replay would revoke the connection). It is an operating
// system lock on a file that stays in place: the system drops it when its holder dies, so a
// crash leaves nothing to clean up, and nothing is created or deleted per refresh.
//
// Older versions took this lock by creating the file with an owner marker in it, holding no
// system lock, and deleting the file when done. While an upgrade is rolling out both versions
// may refresh at the same moment, so the older protocol is honoured: a lock file with a fresh
// owner marker is somebody else's lock and is waited for, and a stale one is taken over.
func (s Store) Lock(timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	path := s.lockFile()
	deadline := time.Now().Add(timeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return nil, err
		}
		if heldByOlderVersion(file) {
			file.Close()
			if time.Now().After(deadline) {
				return nil, ErrLockTimeout
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		acquired, err := tryLock(file)
		if err != nil {
			file.Close()
			return nil, err
		}
		if acquired {
			// An older version deletes its lock file when it is done. What we hold must still
			// be the file at the path, or another process would lock a different file.
			if !stillAtPath(file, path) {
				_ = unlock(file)
				file.Close()
				continue
			}
			// An older version deletes a lock file nobody touched for five minutes.
			now := time.Now()
			_ = os.Chtimes(path, now, now)
			return func() {
				_ = unlock(file)
				_ = file.Close()
			}, nil
		}
		file.Close()
		if time.Now().After(deadline) {
			return nil, ErrLockTimeout
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// heldByOlderVersion reports an older version's live lock: a lock file carrying an owner
// marker, which this version never writes, that was touched recently. A stale marker is
// cleared so it is not mistaken for a holder again.
func heldByOlderVersion(file *os.File) bool {
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		return false
	}
	if time.Since(info.ModTime()) > legacyLockStaleAfter {
		_ = file.Truncate(0)
		return false
	}
	return true
}

func stillAtPath(file *os.File, path string) bool {
	held, err := file.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(path)
	return err == nil && os.SameFile(held, current)
}

// locked runs a write of state files under a short lock of its own, so two processes writing
// at once (a login and another process's refresh, a logout) cannot interleave their bytes. It
// is a different lock from the refresh lock, which is held across a network call and by the
// caller of Save: taking that one again from the same process would wait on itself.
func (s Store) locked(write func() error) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(s.Dir, "state.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		acquired, err := tryLock(file)
		if err != nil {
			return err
		}
		if acquired {
			defer unlock(file)
			return write()
		}
		if time.Now().After(deadline) {
			return ErrLockTimeout
		}
		time.Sleep(20 * time.Millisecond)
	}
}
