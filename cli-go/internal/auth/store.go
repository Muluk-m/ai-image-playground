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
	return Store{Dir: ConfigDir(), UseKeyring: os.Getenv("MUVLOOM_CREDENTIALS_STORE") != "file"}
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
	return WriteFileAtomic(s.credentialsFile(), data)
}

func (s Store) Clear() error {
	if s.UseKeyring {
		// Missing or unavailable keyring entries are fine; the file copy is removed regardless.
		_ = keyring.Delete(keyringService, keyringUser)
	}
	return errors.Join(removeIfExists(s.credentialsFile()), removeIfExists(s.pendingFile()))
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

// Lock serializes credential refresh across concurrent CLI processes, so two processes
// never present the same refresh token (a replay would revoke the connection).
func (s Store) Lock(timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(s.Dir, "credentials.lock")
	deadline := time.Now().Add(timeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			file.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		// A crashed holder leaves the file behind; a refresh never takes this long.
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > time.Minute {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("timed out waiting for another muvloom process to refresh credentials")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
