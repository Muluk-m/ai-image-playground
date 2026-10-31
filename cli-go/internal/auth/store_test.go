package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
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
