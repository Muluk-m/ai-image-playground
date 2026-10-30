package cli

import (
	"bytes"
	"encoding/json"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAuthStatusAndCapabilities(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/me" && r.URL.Path != "/v1/capabilities" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.URL.Path == "/v1/me" {
			_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"account":{"id":"u"},"credits":4,"member":false,"min_cli_version":"0.1.0"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"images":true}}`))
	}))
	defer s.Close()
	store := auth.New(filepath.Join(t.TempDir(), "credentials.json"))
	if err := store.Save(auth.Credentials{AccessToken: "access"}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	a := New(s.URL, store, &out, &bytes.Buffer{})
	if code := a.Run([]string{"auth", "status"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	out.Reset()
	if code := a.Run([]string{"capabilities"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	var env struct {
		OK   bool            `json:"ok"`
		Data map[string]bool `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if !env.OK || !env.Data["images"] {
		t.Fatalf("%s", out.Bytes())
	}
}

func TestImageCreateValidationIsJSON(t *testing.T) {
	var out bytes.Buffer
	a := New("http://127.0.0.1:1", auth.New(filepath.Join(t.TempDir(), "credentials.json")), &out, &bytes.Buffer{})
	if code := a.Run([]string{"images", "create"}); code != 2 {
		t.Fatalf("code %d", code)
	}
	var env map[string]any
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env["ok"] != false {
		t.Fatalf("%s", out.Bytes())
	}
}

func TestLoginResumePollsPendingAndSendsClientID(t *testing.T) {
	var calls int
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/token" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("client_id") != "muvloom-cli" {
			t.Fatalf("client_id=%q", r.Form.Get("client_id"))
		}
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"a","refresh_token":"r","expires_in":60}`))
	}))
	defer s.Close()
	store := auth.New(filepath.Join(t.TempDir(), "credentials.json"))
	if err := store.Save(auth.Credentials{DeviceCode: "device", DeviceExpiresAt: time.Now().Add(time.Minute), PollInterval: time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	a := New(s.URL, store, &out, &bytes.Buffer{})
	if code := a.Run([]string{"auth", "login", "--resume"}); code != 0 {
		t.Fatalf("code=%d output=%s", code, out.String())
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestImageDryRunUsesValidationEndpoint(t *testing.T) {
	var path string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"valid":true}}`))
	}))
	defer s.Close()
	var out bytes.Buffer
	a := New(s.URL, auth.New(filepath.Join(t.TempDir(), "credentials.json")), &out, &bytes.Buffer{})
	if code := a.Run([]string{"images", "create", "--prompt", "test", "--dry-run", "--max-credits", "7"}); code != 0 {
		t.Fatalf("code=%d output=%s", code, out.String())
	}
	if path != "/v1/image-jobs/validate" {
		t.Fatalf("path=%s", path)
	}
}

func TestSkillInstallIsJSONAndUsesProjectRoot(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "project")
	cwd := filepath.Join(project, "nested")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte("module example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(cwd); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	oldHome := os.Getenv("HOME")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Setenv("HOME", oldHome) })
	var out bytes.Buffer
	a := New("http://127.0.0.1:1", auth.New(filepath.Join(home, "credentials.json")), &out, &bytes.Buffer{})
	if code := a.Run([]string{"skill", "install", "--host", "codex", "--scope", "project"}); code != 0 {
		t.Fatalf("code %d: %s", code, out.String())
	}
	var envelope struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.OK || envelope.Data["version"] == nil {
		t.Fatalf("%s", out.Bytes())
	}
	if _, err := os.Stat(filepath.Join(project, ".agents", "skills", "muvloom", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}
