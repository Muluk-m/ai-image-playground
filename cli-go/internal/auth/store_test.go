package auth

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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
	// The operating system drops a lock with its process; the new format leaves nothing behind.
	path := filepath.Join(store.Dir, "credentials.lock")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	unlock, err := store.Lock(200 * time.Millisecond)
	if err != nil {
		t.Fatalf("an empty leftover lock file blocked: %v", err)
	}
	unlock()
}

// Version 0.1.3 and earlier took the lock by creating the file with an owner marker in it,
// held no system lock, and deleted the file when done. During an upgrade both versions may run.
func legacyLock(t *testing.T, dir string, age time.Duration) string {
	t.Helper()
	path := filepath.Join(dir, "credentials.lock")
	if err := os.WriteFile(path, []byte("4242-1700000000000000000"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-age)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestALockTakenByAnOlderVersionIsWaitedFor(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	legacyLock(t, store.Dir, time.Second)
	// Two processes presenting the same refresh token would get the connection revoked.
	if _, err := store.Lock(200 * time.Millisecond); err != ErrLockTimeout {
		t.Fatalf("the lock of a running older version was taken: %v", err)
	}
}

func TestTheLockIsTakenOnceTheOlderVersionHasLetGoOfIt(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	path := legacyLock(t, store.Dir, time.Second)
	go func() {
		time.Sleep(150 * time.Millisecond)
		_ = os.Remove(path) // what the older version does when it is done
	}()
	unlock, err := store.Lock(3 * time.Second)
	if err != nil {
		t.Fatalf("the lock was not taken after the older version let go: %v", err)
	}
	defer unlock()
	// What we hold is the file at the path, not an orphan that nobody else can see.
	held, err := store.Lock(100 * time.Millisecond)
	if err != ErrLockTimeout {
		unlockHeld := held
		if unlockHeld != nil {
			unlockHeld()
		}
		t.Fatalf("a second taker got the lock too: %v", err)
	}
}

func TestAStaleLockFromAnOlderVersionIsTakenOver(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	path := legacyLock(t, store.Dir, 10*time.Minute) // its owner died long ago
	unlock, err := store.Lock(time.Second)
	if err != nil {
		t.Fatalf("a stale older lock blocked: %v", err)
	}
	unlock()
	if info, _ := os.Stat(path); info.Size() != 0 {
		t.Fatalf("the old owner marker was left in the lock file")
	}
}

// An older version treats a lock file untouched for five minutes as dead and deletes it.
func TestTakingTheLockFreshensItsTimestamp(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	path := filepath.Join(store.Dir, "credentials.lock")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	unlock, err := store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if info, _ := os.Stat(path); time.Since(info.ModTime()) > time.Minute {
		t.Fatalf("the held lock looks stale to an older version: %v old", time.Since(info.ModTime()))
	}
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

func TestPendingLoginAndServiceRecordsAreCheckedToo(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	if err := store.SavePending(PendingLogin{DeviceCode: "dev", UserCode: "BCDF-GHJK", BaseURL: "https://api.test", ExpiresAt: time.Now().Add(time.Minute), IntervalSeconds: 5}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	for file, from := range map[string]string{"pending-login.json": `"device_code":"dev"`, "connection.json": `"base_url":"https://api.test"`} {
		path := filepath.Join(store.Dir, file)
		data, _ := os.ReadFile(path)
		garbled := strings.Replace(string(data), from, strings.Replace(from, "dev", "evil", 1), 1)
		garbled = strings.Replace(garbled, "https://api.test", "https://api.evil", 1)
		if garbled == string(data) {
			t.Fatalf("%s has nothing to garble: %s", file, data)
		}
		if err := os.WriteFile(path, []byte(garbled), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.LoadPending(); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("a garbled pending login was used: %v", err)
	}
	if service, err := store.LoadService(); err == nil {
		t.Fatalf("a garbled service record was used: %q", service)
	}
}

// A field added to Credentials later must not make an older binary reject a good record.
func TestARecordWithAFieldAddedLaterStillVerifies(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	future := struct {
		Credentials
		Scope string `json:"scope"`
	}{Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.test"}, "images:write"}
	data, err := frame(future)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Dir, "credentials.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || got.RefreshToken != "r" {
		t.Fatalf("a record with an extra field = %+v, %v", got, err)
	}
}

// Writers take turns, so a reader never sees the bytes of two records mixed.
func TestConcurrentWritersNeverLeaveATornRecord(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	if err := store.Save(Credentials{AccessToken: "a", RefreshToken: "seed", BaseURL: "https://api.test"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 3)
	for _, prefix := range []string{"short", "a-considerably-longer-refresh-token-value-"} {
		go func() {
			for i := 0; i < 40; i++ {
				if err := store.Save(Credentials{AccessToken: "a", RefreshToken: prefix + strconv.Itoa(i), BaseURL: "https://api.test"}); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
	}
	go func() {
		for i := 0; i < 120; i++ {
			if _, err := store.Load(); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < 3; i++ {
		if err := <-done; err != nil {
			t.Fatalf("a writer or reader saw a broken record: %v", err)
		}
	}
	if _, err := store.Load(); err != nil {
		t.Fatalf("final record: %v", err)
	}
}

// The lock must hold across processes, which is the only way two muvloom commands meet.
func TestHelperHoldLock(t *testing.T) {
	dir := os.Getenv("AIP_LOCK_HELPER_DIR")
	if dir == "" {
		t.Skip("helper process only")
	}
	unlock, err := (Store{Dir: dir}).Lock(5 * time.Second)
	if err != nil {
		fmt.Println("error:", err)
		os.Exit(2)
	}
	fmt.Println("locked")
	_, _ = io.Copy(io.Discard, os.Stdin) // hold until the parent closes our stdin
	unlock()
}

func TestTheLockExcludesAnotherProcess(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperHoldLock$")
	cmd.Env = append(os.Environ(), "AIP_LOCK_HELPER_DIR="+store.Dir)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "locked" {
		t.Fatalf("the helper did not take the lock: %q %v", line, err)
	}
	if _, err := store.Lock(150 * time.Millisecond); err != ErrLockTimeout {
		t.Fatalf("a second process took a held lock: %v", err)
	}
	_ = stdin.Close() // the holder exits; the system releases its lock
	_ = cmd.Wait()
	unlock, err := store.Lock(2 * time.Second)
	if err != nil {
		t.Fatalf("the lock was not released with its holder: %v", err)
	}
	unlock()
}

type userKeychain struct {
	entries map[string]string
	err     error
}

func (k *userKeychain) Get(_, user string) (string, error) {
	if k.err != nil {
		return "", k.err
	}
	if v, ok := k.entries[user]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}
func (k *userKeychain) Set(_, user, secret string) error {
	if k.err != nil {
		return k.err
	}
	k.entries[user] = secret
	return nil
}
func (k *userKeychain) Delete(_, user string) error {
	if k.err != nil {
		return k.err
	}
	delete(k.entries, user)
	return nil
}

func TestPreflightLeavesStoredCredentialsAsTheyWere(t *testing.T) {
	t.Run("file", func(t *testing.T) {
		store := Store{Dir: t.TempDir()}
		if err := store.Preflight(); err != nil {
			t.Fatalf("preflight on an empty directory: %v", err)
		}
		if _, err := store.Load(); err != ErrNotFound {
			t.Fatalf("preflight left something that reads as credentials: %v", err)
		}
		saved := Credentials{AccessToken: "a", RefreshToken: "r", BaseURL: "https://api.example"}
		if err := store.Save(saved); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(store.credentialsFile())
		if err := store.Preflight(); err != nil {
			t.Fatalf("preflight with stored credentials: %v", err)
		}
		after, _ := os.ReadFile(store.credentialsFile())
		if !bytes.Equal(before, after) {
			t.Fatal("preflight changed the stored credentials")
		}
	})
	t.Run("keychain", func(t *testing.T) {
		kc := &userKeychain{entries: map[string]string{}}
		store := Store{Dir: t.TempDir(), UseKeyring: true, Keychain: kc}
		if err := store.Save(Credentials{RefreshToken: "r"}); err != nil {
			t.Fatal(err)
		}
		if err := store.Preflight(); err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if len(kc.entries) != 1 || kc.entries[store.keyringUser()] == "" {
			t.Fatalf("keychain after preflight = %v", kc.entries)
		}
		if fileHasContent(store.credentialsFile()) {
			t.Fatal("a working keychain must not be probed through the file")
		}
	})
	t.Run("unwritable", func(t *testing.T) {
		store := Store{Dir: t.TempDir(), UseKeyring: true, Keychain: &userKeychain{entries: map[string]string{}, err: errors.New("locked")}}
		if err := os.Mkdir(store.credentialsFile(), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := store.Preflight(); err == nil {
			t.Fatal("preflight passed although neither the keychain nor the file can be written")
		}
	})
}

// A store in another config directory (MUVLOOM_CONFIG_DIR) must leave the default login in
// the keychain alone: signing in there with file storage, or out again, used to delete it.
func TestAnotherConfigDirectoryNeverTouchesTheDefaultKeychainLogin(t *testing.T) {
	keychain := &userKeychain{entries: map[string]string{defaultKeyringUser: `{"refresh_token":"prod"}`}}
	dir := t.TempDir()
	other := Store{Dir: dir, ClearKeyring: true, Keychain: keychain}
	if other.keyringUser() == defaultKeyringUser {
		t.Fatal("another directory shares the default entry")
	}
	if err := other.Save(Credentials{RefreshToken: "test", BaseURL: "https://test.example"}); err != nil {
		t.Fatal(err)
	}
	if err := other.Clear(); err != nil {
		t.Fatal(err)
	}
	if keychain.entries[defaultKeyringUser] != `{"refresh_token":"prod"}` {
		t.Fatalf("default login changed: %v", keychain.entries)
	}
	withKeychain := Store{Dir: dir, UseKeyring: true, ClearKeyring: true, Keychain: keychain}
	if err := withKeychain.Save(Credentials{RefreshToken: "test", BaseURL: "https://test.example"}); err != nil {
		t.Fatal(err)
	}
	if creds, err := withKeychain.Load(); err != nil || creds.RefreshToken != "test" {
		t.Fatalf("own entry: %v %v", creds, err)
	}
	if keychain.entries[defaultKeyringUser] != `{"refresh_token":"prod"}` {
		t.Fatalf("default login overwritten: %v", keychain.entries)
	}
	// Signed out there, it says the default login exists, so a 0.2.0 user knows to sign in again.
	if err := withKeychain.Clear(); err != nil {
		t.Fatal(err)
	}
	if !withKeychain.DefaultLoginElsewhere() {
		t.Fatal("the default login is not reported")
	}
}

func TestTheDefaultConfigDirectoryKeepsTheExistingKeychainEntry(t *testing.T) {
	if user := (Store{Dir: defaultConfigDir()}).keyringUser(); user != defaultKeyringUser {
		t.Fatalf("default directory moved to %q; existing logins would be lost", user)
	}
	if user := (Store{Dir: defaultConfigDir() + string(filepath.Separator)}).keyringUser(); user != defaultKeyringUser {
		t.Fatalf("a trailing separator got %q", user)
	}
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	if user := Default().keyringUser(); user == defaultKeyringUser {
		t.Fatal("MUVLOOM_CONFIG_DIR shares the default keychain entry")
	}
}

// Every spelling of one directory (here a symlink) names the same entry, because the name
// comes from an id kept in the directory, not from its path.
func TestAnotherDirectoryKeepsOneEntryUnderAnySpelling(t *testing.T) {
	keychain := &userKeychain{entries: map[string]string{}}
	root := t.TempDir()
	target := filepath.Join(root, "target")
	store := Store{Dir: target, UseKeyring: true, Keychain: keychain}
	if store.keyringUser() != "" {
		t.Fatal("a fresh directory already has an entry")
	}
	if err := store.Save(Credentials{RefreshToken: "r", BaseURL: "https://test.example"}); err != nil {
		t.Fatal(err)
	}
	name := store.keyringUser()
	if name == "" || keychain.entries[name] == "" {
		t.Fatalf("saved entry %q: %v", name, keychain.entries)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	via := Store{Dir: filepath.Join(link, "..", "link"), UseKeyring: true, Keychain: keychain}
	if creds, err := via.Load(); err != nil || creds.RefreshToken != "r" {
		t.Fatalf("through the link: %v %v", creds, err)
	}
	if err := via.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, ok := keychain.entries[name]; ok {
		t.Fatal("signing out through the link left the entry")
	}
}
