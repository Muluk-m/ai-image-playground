package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type Credentials struct {
	AccessToken     string        `json:"access_token"`
	RefreshToken    string        `json:"refresh_token"`
	ExpiresAt       time.Time     `json:"expires_at"`
	DeviceCode      string        `json:"device_code,omitempty"`
	UserCode        string        `json:"user_code,omitempty"`
	VerificationURI string        `json:"verification_uri,omitempty"`
	DeviceExpiresAt time.Time     `json:"device_expires_at,omitempty"`
	PollInterval    time.Duration `json:"poll_interval,omitempty"`
}

type Store struct{ Path string }

func DefaultPath() string {
	if p := os.Getenv("MUVLOOM_CREDENTIALS_FILE"); p != "" {
		return p
	}
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "muvloom", "credentials.json")
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".config", "muvloom", "credentials.json")
	}
	return "credentials.json"
}
func New(path string) Store {
	if path == "" {
		path = DefaultPath()
	}
	return Store{Path: path}
}
func (s Store) Load() (Credentials, error) {
	b, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, os.ErrNotExist
	}
	if err != nil {
		return Credentials{}, err
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return Credentials{}, fmt.Errorf("invalid credentials file: %w", err)
	}
	return c, nil
}
func (s Store) Save(c Credentials) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.Path), ".credentials-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
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
	if err := os.Rename(name, s.Path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(s.Path, 0600)
	}
	return nil
}
func (s Store) Clear() error {
	err := os.Remove(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
