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
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "muvloom-cli"
	keyringUser    = "default"
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
}

// PendingLogin is a device authorization that has been started but not yet approved.
type PendingLogin struct {
	DeviceCode              string    `json:"device_code"`
	UserCode                string    `json:"user_code"`
	VerificationURIComplete string    `json:"verification_uri_complete"`
	ExpiresAt               time.Time `json:"expires_at"`
	IntervalSeconds         int       `json:"interval_seconds"`
	BaseURL                 string    `json:"base_url"`
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

// Backend names where credentials currently live, for status output.
func (s Store) Backend() string { return s.Describe().Backend }

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
	return readCredentialsFile(s.credentialsFile())
}

// Save stores the credentials and, beside them, which service they belong to. The service
// address is not a secret: keeping it apart means an unreadable keychain or credential file
// never makes the CLI guess the service.
func (s Store) Save(creds Credentials) error {
	if err := s.saveSecret(creds); err != nil {
		return err
	}
	s.saveService(creds.BaseURL)
	return nil
}

func (s Store) saveSecret(creds Credentials) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	if s.UseKeyring {
		if err := s.keychain().Set(keyringService, keyringUser, string(data)); err == nil {
			// A stale file copy would be read if the keyring later becomes unavailable.
			return truncateIfExists(s.credentialsFile())
		}
	}
	// Write the file before touching the keychain: if the write fails, the previous
	// credentials must still be somewhere.
	record, err := frameCredentials(creds)
	if err != nil {
		return err
	}
	if err := WriteFileInPlace(s.credentialsFile(), record); err != nil {
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

// A credentials file holds the credentials' own fields plus a checksum of them. A record cut
// short by a crash, or edited by hand, fails the check instead of being half trusted. The
// fields keep their names, so an older CLI still reads the file.
type credentialsRecord struct {
	Credentials
	Checksum string `json:"checksum,omitempty"`
}

func credentialsChecksum(creds Credentials) (string, error) {
	data, err := json.Marshal(creds)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func frameCredentials(creds Credentials) ([]byte, error) {
	sum, err := credentialsChecksum(creds)
	if err != nil {
		return nil, err
	}
	return json.Marshal(credentialsRecord{Credentials: creds, Checksum: sum})
}

// readCredentialsFile reads a record another process may be writing at this moment: an
// in-place write is briefly a prefix of the new record, or the new record followed by the tail
// of a longer old one. A few short retries ride that out; a record that stays bad is reported.
func readCredentialsFile(path string) (Credentials, error) {
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(25 * time.Millisecond)
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return Credentials{}, ErrNotFound
		}
		if err != nil {
			return Credentials{}, err
		}
		if len(bytes.TrimSpace(data)) == 0 {
			return Credentials{}, ErrNotFound
		}
		var record credentialsRecord
		if err := json.NewDecoder(bytes.NewReader(data)).Decode(&record); err != nil {
			lastErr = fmt.Errorf("%s is unreadable: %w", filepath.Base(path), err)
			continue
		}
		if record.Checksum != "" {
			want, err := credentialsChecksum(record.Credentials)
			if err != nil {
				return Credentials{}, err
			}
			if want != record.Checksum {
				lastErr = fmt.Errorf("%s failed its integrity check", filepath.Base(path))
				continue
			}
		}
		return record.Credentials, nil
	}
	return Credentials{}, lastErr
}

// saveService is best effort: the connection works without it.
func (s Store) saveService(baseURL string) {
	if baseURL == "" {
		return
	}
	if data, err := json.Marshal(map[string]string{"base_url": baseURL}); err == nil {
		_ = WriteFileInPlace(s.serviceFile(), data)
	}
}

// LoadService returns the service the stored connection belongs to, without reading any
// secret. ErrNotFound means none is recorded.
func (s Store) LoadService() (string, error) {
	var record struct {
		BaseURL string `json:"base_url"`
	}
	if err := readJSON(s.serviceFile(), &record); err != nil {
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
	var keyringErr error
	if s.UseKeyring || s.ClearKeyring {
		if err := s.keychain().Delete(keyringService, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			// An unavailable keychain is only a problem if it still holds our entry.
			if _, getErr := s.keychain().Get(keyringService, keyringUser); getErr == nil {
				keyringErr = fmt.Errorf("could not remove credentials from the system keychain: %w", err)
			}
		}
	}
	return errors.Join(keyringErr, truncateIfExists(s.credentialsFile()), truncateIfExists(s.pendingFile()), truncateIfExists(s.serviceFile()))
}

func (s Store) LoadPending() (PendingLogin, error) {
	var pending PendingLogin
	err := readJSON(s.pendingFile(), &pending)
	return pending, err
}

func (s Store) SavePending(pending PendingLogin) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return WriteFileInPlace(s.pendingFile(), data)
}

func (s Store) ClearPending() error { return truncateIfExists(s.pendingFile()) }

// readJSON reads a small state file. Like a credentials record it may be mid-write, so a
// value that does not parse is retried briefly; only the first JSON value counts, which is
// the new one when it overwrote a longer old one and the old tail is still there.
func readJSON(path string, out any) error {
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
		if err := json.NewDecoder(bytes.NewReader(data)).Decode(out); err != nil {
			lastErr = fmt.Errorf("%s is unreadable: %w", filepath.Base(path), err)
			continue
		}
		return nil
	}
	return lastErr
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
		_ = file.Chmod(0o600)
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

// CleanupLeftovers removes the temporary files earlier versions left in the config directory
// when a rename was refused. Only our own `.tmp-*` files are touched, and failing to remove
// one is not an error: it is housekeeping.
func (s Store) CleanupLeftovers() {
	for _, dir := range []string{s.Dir, filepath.Join(s.Dir, "submissions"), filepath.Join(s.Dir, "updates")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), ".tmp-") {
				_ = os.Remove(filepath.Join(dir, entry.Name()))
			}
		}
	}
}

// Lock serializes credential refresh across concurrent CLI processes, so two processes never
// present the same refresh token (a replay would revoke the connection). It is an operating
// system lock on a file that stays in place: the system drops it when its holder dies, so a
// crash leaves nothing to clean up, and nothing is created or deleted per refresh.
func (s Store) Lock(timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(s.lockFile(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		acquired, err := tryLock(file)
		if err != nil {
			file.Close()
			return nil, err
		}
		if acquired {
			return func() {
				_ = unlock(file)
				_ = file.Close()
			}, nil
		}
		if time.Now().After(deadline) {
			file.Close()
			return nil, ErrLockTimeout
		}
		time.Sleep(50 * time.Millisecond)
	}
}
