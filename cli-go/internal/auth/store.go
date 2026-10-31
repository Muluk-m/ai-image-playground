// Package auth persists CLI credentials. The platform credential store (macOS Keychain,
// Windows Credential Manager, Linux Secret Service) is used when available; otherwise a
// 0600 file under the user config directory. Credential values are never logged.
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "muvloom-cli"
	keyringUser    = "default"
)

// ErrNotFound means no credentials are stored.
var ErrNotFound = errors.New("no stored credentials")

type Credentials struct {
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
	BaseURL          string    `json:"base_url"`
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

// Backend names where credentials currently live, for status output.
func (s Store) Backend() string {
	if s.UseKeyring {
		if _, err := keyring.Get(keyringService, keyringUser); err == nil {
			return "keychain"
		}
	}
	if _, err := os.Stat(s.credentialsFile()); err == nil {
		return "file"
	}
	return "none"
}

func (s Store) Load() (Credentials, error) {
	var creds Credentials
	if s.UseKeyring {
		if secret, err := keyring.Get(keyringService, keyringUser); err == nil {
			if err := json.Unmarshal([]byte(secret), &creds); err != nil {
				return Credentials{}, fmt.Errorf("stored credentials are unreadable: %w", err)
			}
			return creds, nil
		}
	}
	err := readJSON(s.credentialsFile(), &creds)
	return creds, err
}

func (s Store) Save(creds Credentials) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	if s.UseKeyring {
		if err := keyring.Set(keyringService, keyringUser, string(data)); err == nil {
			// A stale file copy would be read if the keyring later becomes unavailable.
			_ = removeIfExists(s.credentialsFile())
			return nil
		}
	}
	// Write the file before touching the keychain: if the write fails, the previous
	// credentials must still be somewhere.
	if err := WriteFileAtomic(s.credentialsFile(), data); err != nil {
		return err
	}
	// Load prefers the keychain, so an older entry there would shadow the file and replay
	// a retired refresh token. This also covers MUVLOOM_CREDENTIALS_STORE=file.
	if s.UseKeyring || s.ClearKeyring {
		if err := keyring.Delete(keyringService, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			if _, getErr := keyring.Get(keyringService, keyringUser); getErr == nil && s.UseKeyring {
				return fmt.Errorf("the system keychain still holds older credentials: %w", err)
			}
		}
	}
	return nil
}

// Clear removes credentials from every backend, whichever one this process is using,
// so switching MUVLOOM_CREDENTIALS_STORE cannot leave a login behind.
func (s Store) Clear() error {
	var keyringErr error
	if !s.UseKeyring && !s.ClearKeyring {
		return errors.Join(removeIfExists(s.credentialsFile()), removeIfExists(s.pendingFile()))
	}
	if err := keyring.Delete(keyringService, keyringUser); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		// An unavailable keychain is only a problem if it still holds our entry.
		if _, getErr := keyring.Get(keyringService, keyringUser); getErr == nil {
			keyringErr = fmt.Errorf("could not remove credentials from the system keychain: %w", err)
		}
	}
	return errors.Join(keyringErr, removeIfExists(s.credentialsFile()), removeIfExists(s.pendingFile()))
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
	return WriteFileAtomic(s.pendingFile(), data)
}

func (s Store) ClearPending() error { return removeIfExists(s.pendingFile()) }

func readJSON(path string, out any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s is unreadable: %w", filepath.Base(path), err)
	}
	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// WriteFileAtomic replaces path with data, readable only by the current user.
func WriteFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// lockStaleAfter must exceed the longest refresh (request timeout plus saving), so a
// live holder is never treated as crashed.
const lockStaleAfter = 5 * time.Minute

// Lock serializes credential refresh across concurrent CLI processes, so two processes
// never present the same refresh token (a replay would revoke the connection). The lock
// file records its owner, and unlock only removes a lock it still owns.
func (s Store) Lock(timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(s.Dir, "credentials.lock")
	owner := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	deadline := time.Now().Add(timeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, writeErr := file.WriteString(owner)
			closeErr := file.Close()
			if err := errors.Join(writeErr, closeErr); err != nil {
				_ = os.Remove(path)
				return nil, err
			}
			return func() {
				if held, err := os.ReadFile(path); err == nil && string(held) == owner {
					_ = os.Remove(path)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > lockStaleAfter {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("timed out waiting for another muvloom process to refresh credentials")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
