package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// fakeServer is a minimal Muvloom API: device flow, rotating tokens, jobs and downloads.
type fakeServer struct {
	t            *testing.T
	mu           sync.Mutex
	server       *httptest.Server
	polls        int
	approveAfter int
	access       string
	refresh      string
	refreshCalls int
	jobPolls     int
	submissions  map[string]string // idempotency key -> request body
	failSubmits  int
	failJob      bool
}

const secretDeviceCode = "device-secret-value"

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{t: t, approveAfter: 2, access: "access-1", refresh: "refresh-1", submissions: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/oauth/device_authorization", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"device_code": secretDeviceCode, "user_code": "BCDF-GHJK",
			"verification_uri": f.server.URL + "/device", "verification_uri_complete": f.server.URL + "/device?user_code=BCDF-GHJK",
			"expires_in": 600, "interval": 1,
		})
	})
	mux.HandleFunc("POST /v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Form.Get("grant_type") {
		case "urn:ietf:params:oauth:grant-type:device_code":
			f.polls++
			if f.polls == 1 {
				writeJSON(w, 400, map[string]string{"error": "slow_down"})
				return
			}
			if f.polls < f.approveAfter {
				writeJSON(w, 400, map[string]string{"error": "authorization_pending"})
				return
			}
			writeJSON(w, 200, f.tokens())
		case "refresh_token":
			f.refreshCalls++
			if r.Form.Get("refresh_token") != f.refresh {
				writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			f.access = "access-" + f.refresh
			f.refresh = f.refresh + "-next"
			writeJSON(w, 200, f.tokens())
		}
	})
	mux.HandleFunc("POST /v1/oauth/revoke", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{}) })
	authed := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			ok := r.Header.Get("Authorization") == "Bearer "+f.access
			f.mu.Unlock()
			if !ok {
				envelope(w, 401, nil, "UNAUTHENTICATED")
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /v1/me", authed(func(w http.ResponseWriter, r *http.Request) {
		envelope(w, 200, map[string]any{"account": map[string]any{"id": "u1", "username": "fox"}, "credits": 42, "member": false, "min_cli_version": "0.1.0"}, "")
	}))
	mux.HandleFunc("POST /v1/image-jobs", authed(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		key, _ := body["idempotency_key"].(string)
		encoded, _ := json.Marshal(body)
		f.mu.Lock()
		f.submissions[key] = string(encoded)
		fail := f.failSubmits > 0
		if fail {
			f.failSubmits--
		}
		f.mu.Unlock()
		if fail {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		if body["max_credits"] == float64(1) {
			envelope(w, 402, nil, "MAX_CREDITS_EXCEEDED")
			return
		}
		envelope(w, 200, map[string]any{"job": map[string]any{"job_id": "job-1", "status": "queued", "terminal": false, "next_poll_after_seconds": 2}, "request_hash": "h", "adjustments": []any{}}, "")
	}))
	mux.HandleFunc("GET /v1/jobs/{id}", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.jobPolls++
		done := f.jobPolls >= 3
		f.mu.Unlock()
		if !done {
			envelope(w, 200, map[string]any{"job_id": "job-1", "status": "running", "terminal": false, "next_poll_after_seconds": 2}, "")
			return
		}
		if f.failJob {
			envelope(w, 200, map[string]any{"job_id": "job-1", "status": "failed", "terminal": true, "error": map[string]any{"code": "upstream_error", "message": "The model failed"}}, "")
			return
		}
		envelope(w, 200, map[string]any{"job_id": "job-1", "status": "succeeded", "terminal": true, "artifacts": []any{map[string]any{"artifact_id": "art_job-1_0", "media_id": "m1", "content_type": "image/png"}}}, "")
	}))
	mux.HandleFunc("GET /v1/artifacts/{id}/download", authed(func(w http.ResponseWriter, r *http.Request) {
		envelope(w, 200, map[string]any{"download_url": f.server.URL + "/files/a.png", "content_type": "image/png"}, "")
	}))
	mux.HandleFunc("GET /files/a.png", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("PNGDATA")) })
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeServer) tokens() map[string]any {
	return map[string]any{"access_token": f.access, "refresh_token": f.refresh, "token_type": "Bearer", "expires_in": 7200, "refresh_token_expires_in": 2592000}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func envelope(w http.ResponseWriter, status int, data any, code string) {
	if code != "" {
		writeJSON(w, status, map[string]any{"schema_version": 1, "ok": false, "error": map[string]string{"code": code, "message": code}})
		return
	}
	writeJSON(w, status, map[string]any{"schema_version": 1, "ok": true, "data": data})
}

type run struct {
	code   int
	stdout string
	stderr string
	out    map[string]any
}

func newApp(t *testing.T, f *fakeServer, dir string) *App {
	t.Setenv("MUVLOOM_CONFIG_DIR", dir)
	return &App{
		APIURL: f.server.URL,
		Store:  auth.Store{Dir: dir},
		HTTP:   f.server.Client(),
		Home:   t.TempDir(),
		CWD:    t.TempDir(),
		Sleep:  func(context.Context, time.Duration) error { return nil },
	}
}

func execute(t *testing.T, app *App, args ...string) run {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app.Out, app.Err = &stdout, &stderr
	code := app.Run(args)
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("stdout must be exactly one JSON line, got %q", stdout.String())
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &out); err != nil {
		t.Fatalf("stdout is not JSON: %q", stdout.String())
	}
	if out["schema_version"] != float64(1) {
		t.Fatalf("missing schema_version: %v", out)
	}
	return run{code: code, stdout: stdout.String(), stderr: stderr.String(), out: out}
}

func login(t *testing.T, app *App) {
	t.Helper()
	if r := execute(t, app, "auth", "login"); r.code != ExitOK {
		t.Fatalf("login failed: %s", r.stdout)
	}
}

func assertNoSecrets(t *testing.T, r run, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if strings.Contains(r.stdout, secret) || strings.Contains(r.stderr, secret) {
			t.Fatalf("output leaked %q", secret)
		}
	}
}

func TestDeviceLoginHandlesSlowDownAndKeepsSecretsOutOfOutput(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 4
	app := newApp(t, f, t.TempDir())
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if !strings.Contains(r.stderr, "BCDF-GHJK") {
		t.Fatalf("stderr should show the user code, got %q", r.stderr)
	}
	assertNoSecrets(t, r, secretDeviceCode, "access-1", "refresh-1")
	if _, err := app.Store.LoadPending(); err != auth.ErrNotFound {
		t.Fatalf("pending login was not cleared: %v", err)
	}
}

func TestLoginNoWaitThenResumeReusesTheSameCode(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	r := execute(t, app, "auth", "login", "--no-wait")
	data := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["state"] != "pending" || data["user_code"] != "BCDF-GHJK" {
		t.Fatalf("no-wait = %d %s", r.code, r.stdout)
	}
	assertNoSecrets(t, r, secretDeviceCode)
	login(t, app)
}

func TestStatusReportsUnauthenticatedWithoutFailing(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	r := execute(t, app, "auth", "status")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "unauthenticated" {
		t.Fatalf("status = %d %s", r.code, r.stdout)
	}
	if r := execute(t, app, "capabilities"); r.code != ExitAuth {
		t.Fatalf("capabilities without login exit = %d", r.code)
	}
}

func TestExpiredAccessTokenRefreshesOnceAndPersists(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.access = "rotated-elsewhere" // the server no longer accepts the stored token
	f.mu.Unlock()
	f.refresh = "refresh-1"
	r := execute(t, app, "auth", "status")
	if r.out["data"].(map[string]any)["state"] != "ready" || f.refreshCalls != 1 {
		t.Fatalf("status after expiry = %s, refreshes = %d", r.stdout, f.refreshCalls)
	}
	creds, _ := app.Store.Load()
	if creds.RefreshToken != "refresh-1-next" {
		t.Fatalf("rotated refresh token not stored: %q", creds.RefreshToken)
	}
	assertNoSecrets(t, r, "refresh-1-next", "access-refresh-1")
}

func TestCreatePersistsTheKeyAndRetriesWithTheSameKey(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	f.failSubmits = 1
	r := execute(t, app, "images", "create", "--prompt", "a fox", "--aspect-ratio", "16:9")
	if r.code != ExitOK {
		t.Fatalf("create = %d %s", r.code, r.stdout)
	}
	data := r.out["data"].(map[string]any)
	key := data["idempotency_key"].(string)
	if len(f.submissions) != 1 || !strings.HasPrefix(key, "cli-") {
		t.Fatalf("retries used different keys: %v", f.submissions)
	}
	var record submission
	sum := sha256.Sum256([]byte(key))
	raw, err := os.ReadFile(filepath.Join(dir, "submissions", hex.EncodeToString(sum[:])+".json"))
	if err != nil || json.Unmarshal(raw, &record) != nil || record.JobID != "job-1" {
		t.Fatalf("local record = %s, %v", raw, err)
	}
}

func TestCreditRejectionUsesTheCreditExitCode(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	r := execute(t, app, "images", "create", "--prompt", "a fox", "--max-credits", "1")
	if r.code != ExitCredits || r.out["ok"] != false {
		t.Fatalf("exit = %d %s", r.code, r.stdout)
	}
	if r := execute(t, app, "images", "create"); r.code != ExitInvalid {
		t.Fatalf("missing prompt exit = %d", r.code)
	}
}

func TestCreateWaitsAndDownloadsWithoutOverwriting(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	out := t.TempDir()
	r := execute(t, app, "images", "create", "--prompt", "a fox", "--wait", "60", "--download", out)
	data := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["job"].(map[string]any)["status"] != "succeeded" {
		t.Fatalf("create --wait = %d %s", r.code, r.stdout)
	}
	saved := filepath.Join(out, "art_job-1_0.png")
	if content, err := os.ReadFile(saved); err != nil || string(content) != "PNGDATA" {
		t.Fatalf("download = %q, %v", content, err)
	}
	again := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", saved)
	if again.code != ExitRejected || again.out["error"].(map[string]any)["code"] != "FILE_EXISTS" {
		t.Fatalf("overwrite attempt = %d %s", again.code, again.stdout)
	}
	if strings.Contains(r.stdout, "/files/a.png") {
		t.Fatal("signed download URL leaked to stdout")
	}
}

func TestWaitReturnsAtTheDeadlineWithoutFailing(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	r := execute(t, app, "jobs", "wait", "job-1", "--timeout", "0")
	data := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["wait_timed_out"] != true {
		t.Fatalf("bounded wait = %d %s", r.code, r.stdout)
	}
}

func TestWaitingOnAFailedJobExitsNonZeroWithTheJob(t *testing.T) {
	f := newFakeServer(t)
	f.failJob = true
	app := newApp(t, f, t.TempDir())
	login(t, app)
	r := execute(t, app, "jobs", "wait", "job-1", "--timeout", "60")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "JOB_FAILED" {
		t.Fatalf("failed job = %d %s", r.code, r.stdout)
	}
	if !strings.Contains(r.stdout, `"status":"failed"`) {
		t.Fatalf("job details missing: %s", r.stdout)
	}
}

func TestUnknownCommandIsAUsageError(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	if r := execute(t, app, "paint"); r.code != ExitInvalid {
		t.Fatalf("exit = %d", r.code)
	}
	if r := execute(t, app, "jobs", "get"); r.code != ExitInvalid {
		t.Fatalf("missing argument exit = %d", r.code)
	}
}

func TestSkillInstallRefusesAProjectWithoutRoot(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	if r := execute(t, app, "skill", "install", "--host", "codex", "--scope", "project"); r.code != ExitInvalid {
		t.Fatalf("project install outside a project = %d %s", r.code, r.stdout)
	}
	r := execute(t, app, "skill", "install", "--host", "codex")
	if r.code != ExitOK {
		t.Fatalf("user install = %d %s", r.code, r.stdout)
	}
	if _, err := os.Stat(filepath.Join(app.Home, ".agents", "skills", "muvloom", "SKILL.md")); err != nil {
		t.Fatalf("SKILL.md not installed: %v", err)
	}
}
