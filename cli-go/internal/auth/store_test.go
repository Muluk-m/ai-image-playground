package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreSaveLoadRestrictive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "credentials.json")
	s := New(path)
	want := Credentials{AccessToken: "access", RefreshToken: "refresh"}
	if err := s.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessToken != want.AccessToken || got.RefreshToken != want.RefreshToken {
		t.Fatalf("got %+v", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
}
