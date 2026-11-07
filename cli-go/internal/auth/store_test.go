package auth

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func TestFileStoreRoundTripWithPrivatePermissions(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	if _, err := store.Load(); err != ErrNotFound {
		t.Fatalf("empty Load err = %v", err)
	}
	want := Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}
	if err := store.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load()
	if err != nil || got.RefreshToken != "r" {
		t.Fatalf("Load = %+v, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(store.Dir, "credentials.json"))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, %v", info.Mode().Perm(), err)
		}
	}
	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err != ErrNotFound {
		t.Fatalf("after Clear err = %v", err)
	}
}

func TestLockIsExclusive(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	unlock, err := store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Lock(200 * time.Millisecond); err == nil {
		t.Fatal("second Lock succeeded while the first was held")
	}
	unlock()
	again, err := store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	again()
}

// A sandbox that guards deleting and replacing files asks about every rename. Credentials are
// updated in place instead: the file keeps its identity for the life of the installation.
func sameFile(t *testing.T, path string, before os.FileInfo) {
	t.Helper()
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("%s is gone: %v", filepath.Base(path), err)
	}
	if !os.SameFile(before, after) {
		t.Fatalf("%s was replaced instead of updated in place", filepath.Base(path))
	}
}

func TestSavingAndClearingCredentialsKeepsTheFileInPlace(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "r-long-enough-to-be-longer-later", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Dir, "credentials.json")
	first, _ := os.Stat(path)

	// A shorter record over a longer one, then a longer one again.
	for _, refresh := range []string{"r", "r-a-considerably-longer-refresh-token-than-before"} {
		if err := store.Save(Credentials{AccessToken: "a", RefreshToken: refresh, BaseURL: "https://api.test"}); err != nil {
			t.Fatal(err)
		}
		sameFile(t, path, first)
		if got, err := store.Load(); err != nil || got.RefreshToken != refresh {
			t.Fatalf("Load after Save = %+v, %v", got, err)
		}
	}

	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	sameFile(t, path, first) // signed out, not deleted
	if _, err := store.Load(); err != ErrNotFound {
		t.Fatalf("Load after Clear = %v", err)
	}
	if err := store.Save(Credentials{AccessToken: "b", RefreshToken: "r2", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	sameFile(t, path, first)
	if entries, _ := filepath.Glob(filepath.Join(store.Dir, ".tmp-*")); len(entries) != 0 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestTheLockFileStaysAndIsReusable(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	unlock, err := store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Dir, "credentials.lock")
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	for i := 0; i < 3; i++ {
		again, err := store.Lock(time.Second)
		if err != nil {
			t.Fatal(err)
		}
		again()
		sameFile(t, path, first) // never deleted, never recreated
	}
}

func TestALockHeldByADeadProcessDoesNotBlock(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	// The operating system drops a lock with its process; a leftover file means nothing.
	if err := os.WriteFile(filepath.Join(store.Dir, "credentials.lock"), []byte("pid-that-died"), 0o600); err != nil {
		t.Fatal(err)
	}
	unlock, err := store.Lock(200 * time.Millisecond)
	if err != nil {
		t.Fatalf("a leftover lock file blocked: %v", err)
	}
	unlock()
}

func TestLockTimeoutIsDistinctFromStorageFailure(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	unlock, err := store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := store.Lock(100 * time.Millisecond); err != ErrLockTimeout {
		t.Fatalf("contention = %v, want ErrLockTimeout", err)
	}
}

func TestLoadAcceptsTheOldFormatAndRejectsATamperedRecord(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	path := filepath.Join(store.Dir, "credentials.json")
	legacy := `{"access_token":"a","refresh_token":"legacy-r","base_url":"https://api.test"}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || got.RefreshToken != "legacy-r" {
		t.Fatalf("legacy record = %+v, %v", got, err)
	}

	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	tampered := strings.Replace(string(data), `"refresh_token":"r"`, `"refresh_token":"x"`, 1)
	if tampered == string(data) {
		t.Fatalf("record has no refresh token to tamper with: %s", data)
	}
	if err := os.WriteFile(path, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil || err == ErrNotFound || !strings.Contains(err.Error(), "integrity") {
		t.Fatalf("tampered record = %v", err)
	}
}

// A longer record replaced by a shorter one is briefly followed by the old tail.
func TestLoadIgnoresTheTailOfAnOlderLongerRecord(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Dir, "credentials.json")
	data, _ := os.ReadFile(path)
	if err := os.WriteFile(path, append(data, []byte(`","old":"tail"}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || got.RefreshToken != "r" {
		t.Fatalf("Load with a stale tail = %+v, %v", got, err)
	}
}

type fakeKeychain struct {
	secret string
	err    error
}

func (k *fakeKeychain) Get(string, string) (string, error) {
	if k.err != nil {
		return "", k.err
	}
	if k.secret == "" {
		return "", keyring.ErrNotFound
	}
	return k.secret, nil
}
func (k *fakeKeychain) Set(_, _, secret string) error {
	if k.err != nil {
		return k.err
	}
	k.secret = secret
	return nil
}
func (k *fakeKeychain) Delete(string, string) error {
	if k.err != nil {
		return k.err
	}
	k.secret = ""
	return nil
}

func TestKeychainIsPreferredAndTheFileCopyEmptiedNotDeleted(t *testing.T) {
	keychain := &fakeKeychain{}
	store := Store{Dir: t.TempDir(), UseKeyring: true, Keychain: keychain}
	path := filepath.Join(store.Dir, "credentials.json")
	if err := os.WriteFile(path, []byte(`{"access_token":"old","refresh_token":"stale","base_url":"https://api.test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	first, _ := os.Stat(path)

	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "fresh", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	if info := store.Describe(); info.Backend != "keychain" || info.KeychainIssue != "" {
		t.Fatalf("Describe = %+v", info)
	}
	sameFile(t, path, first)
	if data, _ := os.ReadFile(path); len(strings.TrimSpace(string(data))) != 0 {
		t.Fatalf("a stale secret was left in the file: %q", data)
	}
	if got, err := store.Load(); err != nil || got.RefreshToken != "fresh" {
		t.Fatalf("Load = %+v, %v", got, err)
	}
}

func TestAnUnavailableKeychainFallsBackToTheFileAndSaysWhy(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want string
	}{
		"refused":     {errors.New("User interaction is not allowed: /Users/someone/secret"), "unavailable"},
		"unsupported": {keyring.ErrUnsupportedPlatform, "unsupported_platform"},
	} {
		t.Run(name, func(t *testing.T) {
			store := Store{Dir: t.TempDir(), UseKeyring: true, Keychain: &fakeKeychain{err: tc.err}}
			if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}); err != nil {
				t.Fatal(err)
			}
			info := store.Describe()
			if info.Backend != "file" || info.KeychainIssue != tc.want {
				t.Fatalf("Describe = %+v, want file / %s", info, tc.want)
			}
			if strings.Contains(info.KeychainIssue, "someone") {
				t.Fatal("the keychain's own error text leaked")
			}
			if got, err := store.Load(); err != nil || got.RefreshToken != "r" {
				t.Fatalf("Load = %+v, %v", got, err)
			}
		})
	}
}

func TestLeftoverTemporaryFilesAreRemovedOnlyWhenTheyAreOurs(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	for _, name := range []string{".tmp-1111", ".tmp-2222"} {
		if err := os.WriteFile(filepath.Join(store.Dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	other := filepath.Join(store.Dir, "notes.txt")
	if err := os.WriteFile(other, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.CleanupLeftovers()
	if left, _ := filepath.Glob(filepath.Join(store.Dir, ".tmp-*")); len(left) != 0 {
		t.Fatalf("leftovers remain: %v", left)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("an unrelated file was removed: %v", err)
	}
}
