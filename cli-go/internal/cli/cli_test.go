package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

// fakeServer is a minimal Muvloom API: device flow, rotating tokens, jobs and downloads.
type fakeServer struct {
	t              *testing.T
	mu             sync.Mutex
	server         *httptest.Server
	polls          int
	approveAfter   int
	access         string
	refresh        string
	refreshCalls   int
	jobPolls       int
	submissions    map[string]string // idempotency key -> request body
	failSubmits    int
	failJob        bool
	deviceError    string
	deviceRedeemed bool
	// refreshMode makes the refresh endpoint misbehave: "drop" closes the connection,
	// "5xx" answers 503 with no envelope, "429" answers a rate limit, "lose" rotates and then
	// closes the connection, as if the response were lost. Empty is healthy.
	refreshMode string
	// Request identities the CLI sent, in order, and what the server remembers to replay.
	deviceRequestIDs  []string
	refreshRequestIDs []string
	redeemedWith      string
	lastRefreshID     string
	retiredRefresh    string
	deviceAuthCalls   int
	// onRedeem runs after the server issued tokens for the device code, before it answers.
	onRedeem func()
	// ignoreRequestID behaves like a service that predates request identities.
	ignoreRequestID bool
	// expiredOnce answers the next refresh with an access token that has no lifetime left.
	expiredOnce bool
}

const secretDeviceCode = "device-secret-value"

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{t: t, approveAfter: 2, access: "access-1", refresh: "refresh-1", submissions: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/oauth/device_authorization", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.deviceRedeemed = false
		f.deviceAuthCalls++
		f.mu.Unlock()
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
			f.deviceRequestIDs = append(f.deviceRequestIDs, r.Form.Get("request_id"))
			if f.deviceError != "" {
				writeJSON(w, 400, map[string]string{"error": f.deviceError})
				return
			}
			if f.deviceRedeemed {
				if id := r.Form.Get("request_id"); id != "" && id == f.redeemedWith && !f.ignoreRequestID {
					writeJSON(w, 200, f.tokens())
					return
				}
				writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			if f.polls == 1 {
				writeJSON(w, 400, map[string]string{"error": "slow_down"})
				return
			}
			if f.polls < f.approveAfter {
				writeJSON(w, 400, map[string]string{"error": "authorization_pending"})
				return
			}
			f.deviceRedeemed = true
			f.redeemedWith = r.Form.Get("request_id")
			if f.onRedeem != nil {
				f.mu.Unlock()
				f.onRedeem()
				f.mu.Lock()
			}
			writeJSON(w, 200, f.tokens())
		case "refresh_token":
			f.refreshCalls++
			id := r.Form.Get("request_id")
			f.refreshRequestIDs = append(f.refreshRequestIDs, id)
			if r.Form.Get("refresh_token") == f.retiredRefresh && id != "" && id == f.lastRefreshID && f.refreshMode == "" {
				writeJSON(w, 200, f.tokens())
				return
			}
			switch f.refreshMode {
			case "drop":
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					_ = conn.Close()
				}
				return
			case "5xx":
				w.WriteHeader(503)
				return
			case "429":
				writeJSON(w, 429, map[string]string{"error": "slow_down"})
				return
			}
			if r.Form.Get("refresh_token") != f.refresh {
				writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			f.retiredRefresh, f.lastRefreshID = f.refresh, id
			f.access = "access-" + f.refresh
			f.refresh = f.refresh + "-next"
			if f.expiredOnce {
				f.expiredOnce = false
				tokens := f.tokens()
				tokens["expires_in"] = 0
				writeJSON(w, 200, tokens)
				return
			}
			if f.refreshMode == "lose" {
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					_ = conn.Close()
				}
				return
			}
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

func TestLoginReplayAfterCleanupInterruptionReusesSavedCredentials(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "unexpired", true: "expired"}[expired], func(t *testing.T) {
			f := newFakeServer(t)
			app := newApp(t, f, t.TempDir())
			execute(t, app, "auth", "login", "--no-wait")
			pending, err := app.Store.LoadPending()
			if err != nil {
				t.Fatal(err)
			}
			login(t, app)
			// Restore the cleanup that a host interrupted, then replay the command.
			if expired {
				pending.ExpiresAt = time.Now().Add(-time.Minute)
			}
			if err := app.Store.SavePending(pending); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			polls := f.polls
			f.mu.Unlock()
			r := execute(t, app, "auth", "login")
			if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
				t.Fatalf("replay = %d %s", r.code, r.stdout)
			}
			if _, ok := r.out["data"].(map[string]any)["pending_login"]; ok {
				t.Fatal("completed login shown as pending")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.polls != polls {
				t.Fatal("replay redeemed an already consumed device code")
			}
			assertNoSecrets(t, r, secretDeviceCode, "access-1", "refresh-1")
		})
	}
}

func TestCredentialSaveFailurePreservesPendingLogin(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	execute(t, app, "auth", "login", "--no-wait")
	path := filepath.Join(app.Store.Dir, "credentials.json")
	// The store then becomes unwritable: the empty file left by the write check gives way.
	_ = os.Remove(path)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "block"), []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "CREDENTIAL_STORE_UNWRITABLE" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	polls := f.polls
	f.mu.Unlock()
	if polls != 0 {
		t.Fatalf("redeemed the device code although nothing could be stored: %d polls", polls)
	}
	if _, err := app.Store.LoadPending(); err != nil {
		t.Fatalf("pending login lost before save: %v", err)
	}
	assertNoSecrets(t, r, secretDeviceCode, "access-1", "refresh-1")
}

func TestLoginChecksTheCredentialStoreBeforeAskingForApproval(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	if err := os.Mkdir(filepath.Join(app.Store.Dir, "credentials.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "CREDENTIAL_STORE_UNWRITABLE" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if f.deviceAuthCalls != 0 || f.polls != 0 {
		t.Fatalf("asked for approval anyway: %d authorizations, %d polls", f.deviceAuthCalls, f.polls)
	}
}

// The code is redeemed, but the credentials cannot be written. Fixing the directory and running
// the same command again finishes the login with the same tokens, without a new approval.
func TestLoginFinishesAfterAFailedSaveWithoutApprovingAgain(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	creds := filepath.Join(app.Store.Dir, "credentials.json")
	f.onRedeem = func() {
		_ = os.Remove(creds)
		_ = os.Mkdir(creds, 0o700)
		_ = os.WriteFile(filepath.Join(creds, "block"), []byte("block"), 0o600)
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "CREDENTIAL_STORE_UNWRITABLE" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	assertNoSecrets(t, r, secretDeviceCode, "access-1", "refresh-1")

	f.mu.Lock()
	f.onRedeem = nil
	f.mu.Unlock()
	if err := os.RemoveAll(creds); err != nil {
		t.Fatal(err)
	}
	// Even after the code itself expired.
	pending, err := app.Store.LoadPending()
	if err != nil || !pending.Redeemed {
		t.Fatalf("pending login after a failed save = %+v %v", pending, err)
	}
	pending.ExpiresAt = time.Now().Add(-time.Minute)
	if err := app.Store.SavePending(pending); err != nil {
		t.Fatal(err)
	}
	r = execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("second login = %d %s", r.code, r.stdout)
	}
	if strings.Contains(r.stderr, "BCDF-GHJK") {
		t.Fatalf("asked for approval again: %s", r.stderr)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deviceAuthCalls != 1 {
		t.Fatalf("started a new device authorization: %d", f.deviceAuthCalls)
	}
	ids := f.deviceRequestIDs
	if len(ids) < 2 || ids[0] == "" || ids[len(ids)-1] != ids[0] {
		t.Fatalf("redemptions did not share one request identity: %q", ids)
	}
	stored, err := app.Store.Load()
	if err != nil || stored.RefreshToken != "refresh-1" {
		t.Fatalf("stored credentials = %q %v", stored.RefreshToken, err)
	}
}

// The refresh went through on the server but its response was lost. The next refresh presents
// the same old token with the same stored request identity and gets the same tokens back.
func TestALostRefreshResponseIsRecoveredWithTheSameRequestID(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.access, f.refreshMode = "rotated-elsewhere", "lose"
	f.mu.Unlock()

	r := execute(t, app, "jobs", "get", "job-1")
	if r.code != ExitTemporary || r.out["error"].(map[string]any)["code"] != "NETWORK_ERROR" {
		t.Fatalf("command during the lost response = %d %s", r.code, r.stdout)
	}
	pendingID := ""
	if creds, err := app.Store.Load(); err != nil || creds.RefreshToken != "refresh-1" || creds.RefreshRequestID == "" {
		t.Fatalf("the request identity was not kept: %+v %v", creds, err)
	} else {
		pendingID = creds.RefreshRequestID
	}

	f.mu.Lock()
	f.refreshMode = ""
	f.mu.Unlock()
	if r := execute(t, app, "jobs", "get", "job-1"); r.code != ExitOK {
		t.Fatalf("command after the lost response = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	ids := append([]string(nil), f.refreshRequestIDs...)
	f.mu.Unlock()
	if len(ids) != 2 || ids[0] != pendingID || ids[1] != pendingID {
		t.Fatalf("the retry did not carry the same identity: %q", ids)
	}
	creds, err := app.Store.Load()
	if err != nil || creds.RefreshToken != "refresh-1-next" || creds.RefreshRequestID != "" {
		t.Fatalf("recovered credentials = %+v %v", creds, err)
	}
	assertNoSecrets(t, r, "refresh-1-next", pendingID)
}

func TestACompletedRefreshRequestIDIsReplacedAndRetried(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	creds, _ := app.Store.Load()
	creds.RefreshRequestID = "11111111-1111-4111-8111-111111111111"
	if err := app.Store.Save(creds); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.access = "rotated-elsewhere"
	f.mu.Unlock()
	completed := true
	f.mu.Lock()
	f.refreshMode = ""
	f.mu.Unlock()
	// Answer the stale identity as the service does, once.
	mux := f.server.Config.Handler
	f.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if completed && r.URL.Path == "/v1/oauth/token" && r.Form.Get("request_id") == creds.RefreshRequestID {
			completed = false
			writeJSON(w, 400, map[string]string{"error": "refresh_request_completed"})
			return
		}
		mux.ServeHTTP(w, r)
	})
	if r := execute(t, app, "jobs", "get", "job-1"); r.code != ExitOK {
		t.Fatalf("command = %d %s", r.code, r.stdout)
	}
	stored, _ := app.Store.Load()
	if stored.RefreshToken != "refresh-1-next" || stored.RefreshRequestID != "" {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestDeviceGrantErrorsDistinguishConsumedFromExpired(t *testing.T) {
	for _, tc := range []struct{ oauth, code string }{{"invalid_grant", "AUTH_REQUIRED"}, {"expired_token", "AUTH_EXPIRED"}} {
		t.Run(tc.oauth, func(t *testing.T) {
			f := newFakeServer(t)
			f.deviceError = tc.oauth
			app := newApp(t, f, t.TempDir())
			r := execute(t, app, "auth", "login")
			if r.code != ExitAuth || r.out["error"].(map[string]any)["code"] != tc.code {
				t.Fatalf("login = %d %s", r.code, r.stdout)
			}
			assertNoSecrets(t, r, secretDeviceCode, "access-1", "refresh-1")
		})
	}
}

func TestPendingLoginDoesNotReuseUnrelatedCredentials(t *testing.T) {
	for _, otherAPI := range []bool{false, true} {
		t.Run(map[bool]string{false: "different-code", true: "different-api"}[otherAPI], func(t *testing.T) {
			f := newFakeServer(t)
			app := newApp(t, f, t.TempDir())
			login(t, app)
			creds, err := app.Store.Load()
			if err != nil {
				t.Fatal(err)
			}
			if otherAPI {
				creds.BaseURL = "https://other.test"
			} else {
				creds.LoginDeviceCodeHash = deviceCodeHash("unrelated")
			}
			if err := app.Store.Save(creds); err != nil {
				t.Fatal(err)
			}
			execute(t, app, "auth", "login", "--switch-service", "--no-wait")
			f.mu.Lock()
			f.deviceError = "authorization_pending"
			f.mu.Unlock()
			r := execute(t, app, "auth", "login", "--switch-service", "--timeout", "0")
			if r.code != ExitAuth || r.out["error"].(map[string]any)["code"] != "AUTH_PENDING" {
				t.Fatalf("unrelated login reused: %s", r.stdout)
			}
		})
	}
}

// A new agent session has no MUVLOOM_API_URL; the connection already knows its service.
func TestServiceFollowsTheStoredConnectionWithoutAnOverride(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	login(t, newApp(t, f, dir))

	fresh := newApp(t, f, dir)
	fresh.APIURL = ""
	r := execute(t, fresh, "auth", "status")
	data := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["state"] != "ready" {
		t.Fatalf("status = %d %s", r.code, r.stdout)
	}
	if data["api_url"] != f.server.URL || data["api_url_source"] != "connection" {
		t.Fatalf("service = %v (%v), want the stored connection", data["api_url"], data["api_url_source"])
	}
	if r := execute(t, fresh, "jobs", "get", "job-1"); r.code != ExitOK {
		t.Fatalf("a command without an override = %d %s", r.code, r.stdout)
	}
}

func TestServiceDefaultsWhenNothingIsStoredAndNothingIsSet(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	app.APIURL = ""
	r := execute(t, app, "auth", "status")
	data := r.out["data"].(map[string]any)
	if data["state"] != "unauthenticated" || data["api_url"] != DefaultAPIURL || data["api_url_source"] != "default" {
		t.Fatalf("status = %s", r.stdout)
	}
}

func TestExplicitOverrideConflictingWithTheConnectionReportsAMismatch(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	login(t, newApp(t, f, dir))

	other := newApp(t, f, dir)
	other.APIURL = "https://other.example"
	r := execute(t, other, "auth", "status")
	data := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["state"] != "service_mismatch" {
		t.Fatalf("status = %d %s", r.code, r.stdout)
	}
	if data["api_url"] != "https://other.example" || data["api_url_source"] != "environment" || data["connection_api_url"] != f.server.URL {
		t.Fatalf("mismatch details = %s", r.stdout)
	}
	// The connection is neither used against the wrong service nor dropped.
	if r := execute(t, other, "jobs", "get", "job-1"); r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "SERVICE_MISMATCH" {
		t.Fatalf("a command under a mismatch = %d %s", r.code, r.stdout)
	}
	if _, err := other.Store.Load(); err != nil {
		t.Fatalf("the stored connection was removed: %v", err)
	}
}

func TestLoginRefusesToReplaceAConnectionOnAnotherServiceUnlessAsked(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	creds, err := app.Store.Load()
	if err != nil {
		t.Fatal(err)
	}
	creds.BaseURL = "https://old.example" // the connection belongs to another service
	if err := app.Store.Save(creds); err != nil {
		t.Fatal(err)
	}

	r := execute(t, app, "auth", "login", "--no-wait")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "SERVICE_MISMATCH" {
		t.Fatalf("login under a mismatch = %d %s", r.code, r.stdout)
	}
	if _, err := app.Store.LoadPending(); err != auth.ErrNotFound {
		t.Fatalf("a login was started anyway: %v", err)
	}

	// The user can still move to the other service on purpose.
	r = execute(t, app, "auth", "login", "--switch-service", "--no-wait")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "pending" {
		t.Fatalf("--switch-service = %d %s", r.code, r.stdout)
	}
	login(t, app)
	if got, _ := app.Store.Load(); got.BaseURL != f.server.URL {
		t.Fatalf("connection service after switching = %q", got.BaseURL)
	}
}

// The real entry point, with no MUVLOOM_API_URL: commands that never talk to the service
// must not depend on a service address.
func TestCommandsThatSkipTheServiceWorkWithoutAnAPIURL(t *testing.T) {
	t.Setenv("MUVLOOM_API_URL", "")
	t.Setenv("MUVLOOM_CONFIG_DIR", t.TempDir())
	t.Setenv("MUVLOOM_CREDENTIALS_STORE", "file")
	for _, args := range [][]string{{"version"}, {"skill", "status"}} {
		var stdout, stderr bytes.Buffer
		app := New(&stdout, &stderr)
		app.Home, app.CWD = t.TempDir(), t.TempDir()
		if code := app.Run(args); code != ExitOK {
			t.Fatalf("muvloom %s = %d %s", strings.Join(args, " "), code, stdout.String())
		}
	}
}

// An unreadable store hides which service the user signed in to. Guessing the default would
// send an enterprise user to a sign-in page they cannot use.
func TestLoginDoesNotGuessTheServiceWhenTheStoredConnectionIsUnreadable(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newApp(t, f, dir)
	app.APIURL = ""
	r := execute(t, app, "auth", "login", "--no-wait")
	if r.code == ExitOK || !strings.Contains(r.stdout, "could not be read") {
		t.Fatalf("login with an unreadable store = %d %s", r.code, r.stdout)
	}
	if _, err := app.Store.LoadPending(); err != auth.ErrNotFound {
		t.Fatalf("a login was started against a guessed service: %v", err)
	}

	// An explicit service is a deliberate choice, so signing in again is fine.
	chosen := newApp(t, f, dir)
	if r := execute(t, chosen, "auth", "login", "--no-wait"); r.code != ExitOK {
		t.Fatalf("login with an explicit service = %d %s", r.code, r.stdout)
	}
}

func TestATrailingSlashOnTheStoredServiceIsNotAMismatch(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	creds, _ := app.Store.Load()
	creds.BaseURL += "/"
	if err := app.Store.Save(creds); err != nil {
		t.Fatal(err)
	}
	if r := execute(t, app, "auth", "status"); r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("status = %s", r.stdout)
	}
}

// guardNetwork lets an app reach only the fake server, so a test that fails by choosing the
// wrong service cannot touch a real one.
func guardNetwork(app *App, f *fakeServer) {
	host := strings.TrimPrefix(f.server.URL, "http://")
	app.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != host {
			return nil, &net.DNSError{Err: "blocked by the test: " + r.URL.Host, Name: r.URL.Host}
		}
		return http.DefaultTransport.RoundTrip(r)
	})}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// `login --no-wait` with the service chosen once, then a new session without the variable.
func TestAPendingLoginKeepsItsServiceAcrossSessions(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	first := newApp(t, f, dir)
	if r := execute(t, first, "auth", "login", "--no-wait"); r.code != ExitOK {
		t.Fatalf("no-wait = %d %s", r.code, r.stdout)
	}

	next := newApp(t, f, dir)
	next.APIURL = ""
	guardNetwork(next, f)
	r := execute(t, next, "auth", "login")
	data, _ := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["state"] != "ready" || data["api_url"] != f.server.URL || data["api_url_source"] != "pending_login" {
		t.Fatalf("resumed login = %d %s", r.code, r.stdout)
	}
}

// The keychain may refuse a read while the connection still exists. The service address holds
// no secret and is kept apart, so an unreadable secret never makes the CLI guess the service.
func TestTheServiceIsKnownEvenWhenTheStoredSecretCannotBeRead(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	login(t, newApp(t, f, dir))
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := newApp(t, f, dir)
	app.APIURL = ""
	guardNetwork(app, f)
	status := execute(t, app, "auth", "status")
	data := status.out["data"].(map[string]any)
	if data["api_url"] != f.server.URL || data["api_url_source"] != "connection" || data["state"] != "unauthenticated" {
		t.Fatalf("status = %s", status.stdout)
	}
	if r := execute(t, app, "auth", "login", "--no-wait"); r.code != ExitOK {
		t.Fatalf("login for the known service = %d %s", r.code, r.stdout)
	}
	if pending, err := app.Store.LoadPending(); err != nil || pending.BaseURL != f.server.URL {
		t.Fatalf("pending login service = %q (%v)", pending.BaseURL, err)
	}

	// Signing out forgets the service as well.
	_ = execute(t, newApp(t, f, dir), "auth", "logout")
	gone := newApp(t, f, dir)
	gone.APIURL = ""
	if r := execute(t, gone, "auth", "status"); r.out["data"].(map[string]any)["api_url_source"] != "default" {
		t.Fatalf("service kept after logout: %s", r.stdout)
	}
}

// The store's own failure text can carry local paths; the answer must stay generic.
func TestUnreadableStoreMessageDoesNotEchoTheStoreError(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newApp(t, f, dir)
	app.APIURL = ""
	guardNetwork(app, f)
	r := execute(t, app, "auth", "login", "--no-wait")
	if r.code == ExitOK || strings.Contains(r.stdout, "credentials.json") || strings.Contains(r.stdout, dir) {
		t.Fatalf("refusal = %d %s", r.code, r.stdout)
	}
}

// Switching service takes two sessions: start it, then finish it without the variable. Only the
// login resumes the switch; every other command keeps using the working connection meanwhile.
func TestAnOngoingServiceSwitchIsResumedByLoginOnly(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	creds, _ := app.Store.Load()
	creds.BaseURL = "https://old.example" // the working connection belongs to another service
	if err := app.Store.Save(creds); err != nil {
		t.Fatal(err)
	}
	if r := execute(t, app, "auth", "login", "--switch-service", "--no-wait"); r.code != ExitOK {
		t.Fatalf("start of the switch = %d %s", r.code, r.stdout)
	}

	other := newApp(t, f, dir)
	other.APIURL = ""
	guardNetwork(other, f)
	if r := execute(t, other, "auth", "status"); r.out["data"].(map[string]any)["api_url_source"] != "connection" {
		t.Fatalf("a command other than login left the working connection: %s", r.stdout)
	}

	next := newApp(t, f, dir)
	next.APIURL = ""
	guardNetwork(next, f)
	r := execute(t, next, "auth", "login")
	data, _ := r.out["data"].(map[string]any)
	if r.code != ExitOK || data["state"] != "ready" || data["api_url"] != f.server.URL || data["api_url_source"] != "pending_login" {
		t.Fatalf("the switch was not resumed = %d %s", r.code, r.stdout)
	}
	if got, _ := next.Store.Load(); got.BaseURL != f.server.URL {
		t.Fatalf("connection service after the switch = %q", got.BaseURL)
	}
}

// A transient refresh failure must never be reported as being signed out: the agent would
// start another login and open another approval page.
func TestRefreshOutageIsTemporaryAndKeepsTheConnection(t *testing.T) {
	for mode, want := range map[string]string{"drop": "NETWORK_ERROR", "5xx": "TEMPORARILY_UNAVAILABLE", "429": "RATE_LIMITED"} {
		t.Run(mode, func(t *testing.T) {
			f := newFakeServer(t)
			app := newApp(t, f, t.TempDir())
			login(t, app)
			f.mu.Lock()
			f.access, f.refreshMode = "rotated-elsewhere", mode
			f.mu.Unlock()

			r := execute(t, app, "jobs", "get", "job-1")
			if r.code != ExitTemporary || r.out["error"].(map[string]any)["code"] != want {
				t.Fatalf("command during a refresh outage = %d %s, want %s", r.code, r.stdout, want)
			}
			status := execute(t, app, "auth", "status")
			data := status.out["data"].(map[string]any)
			if status.code != ExitOK || data["state"] != "unreachable" || data["error"].(map[string]any)["code"] != want {
				t.Fatalf("status during a refresh outage = %s", status.stdout)
			}
			if creds, err := app.Store.Load(); err != nil || creds.RefreshToken != "refresh-1" {
				t.Fatalf("the connection was not kept: %v %q", err, creds.RefreshToken)
			}

			f.mu.Lock()
			f.refreshMode = ""
			f.mu.Unlock()
			if r := execute(t, app, "jobs", "get", "job-1"); r.code != ExitOK {
				t.Fatalf("command after the outage = %d %s", r.code, r.stdout)
			}
		})
	}
}

func TestRefreshLockTimeoutIsTemporary(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	f.mu.Lock()
	f.access = "rotated-elsewhere"
	f.mu.Unlock()
	// Another process is in the middle of refreshing: it holds the credential lock.
	release, err := app.Store.Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	app.RefreshLockWait = 50 * time.Millisecond

	r := execute(t, app, "jobs", "get", "job-1")
	if r.code != ExitTemporary || r.out["error"].(map[string]any)["code"] != "TEMPORARILY_UNAVAILABLE" {
		t.Fatalf("command while another process refreshes = %d %s", r.code, r.stdout)
	}
	if f.refreshCalls != 0 {
		t.Fatalf("refreshed without holding the lock: %d calls", f.refreshCalls)
	}
}

func TestRevokedConnectionAsksToSignInAgainAndForgetsIt(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.access, f.refresh = "rotated-elsewhere", "server-rotated-away"
	f.mu.Unlock()

	r := execute(t, app, "jobs", "get", "job-1")
	if r.code != ExitAuth || r.out["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
		t.Fatalf("revoked connection = %d %s", r.code, r.stdout)
	}
	if _, err := app.Store.Load(); err != auth.ErrNotFound {
		t.Fatalf("the dead connection was kept: %v", err)
	}
	if status := execute(t, app, "auth", "status"); status.out["data"].(map[string]any)["state"] != "unauthenticated" {
		t.Fatalf("status after revocation = %s", status.stdout)
	}
}

// A lock that cannot be created is a broken credential directory, not a busy refresh: telling
// the agent to retry would hide the real problem.
func TestUnwritableCredentialDirectoryIsNotReportedAsABusyRefresh(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("directory permissions are not enforced here")
	}
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	f.mu.Lock()
	f.access = "rotated-elsewhere"
	f.mu.Unlock()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	r := execute(t, app, "jobs", "get", "job-1")
	errBody := r.out["error"].(map[string]any)
	if errBody["code"] == "TEMPORARILY_UNAVAILABLE" || strings.Contains(errBody["message"].(string), "refreshing") {
		t.Fatalf("a permission error was reported as a busy refresh: %s", r.stdout)
	}
	if strings.Contains(r.stdout, dir) {
		t.Fatalf("the raw filesystem error leaked: %s", r.stdout)
	}
	if f.refreshCalls != 0 {
		t.Fatalf("refreshed without the lock: %d", f.refreshCalls)
	}
}

func fileIdentity(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("%s: %v", filepath.Base(path), err)
	}
	return info
}

func assertSameFile(t *testing.T, path string, before os.FileInfo, what string) {
	t.Helper()
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("%s: %s deleted %s", what, filepath.Base(path), err)
	}
	if !os.SameFile(before, after) {
		t.Fatalf("%s: %s was replaced instead of updated in place", what, filepath.Base(path))
	}
}

// A sandbox that asks before deleting or replacing files must have nothing to ask about
// while a user signs in, refreshes or signs out.
func TestSigningInRefreshingAndOutNeverReplaceOrDeleteFiles(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	creds := filepath.Join(dir, "credentials.json")
	service := filepath.Join(dir, "connection.json")
	credsID, serviceID := fileIdentity(t, creds), fileIdentity(t, service)

	for round := 1; round <= 2; round++ {
		f.mu.Lock()
		f.access = "rotated-elsewhere"
		f.mu.Unlock()
		if r := execute(t, app, "jobs", "get", "job-1"); r.code != ExitOK {
			t.Fatalf("refresh round %d = %d %s", round, r.code, r.stdout)
		}
		assertSameFile(t, creds, credsID, "refresh")
		assertSameFile(t, service, serviceID, "refresh")
	}
	lockID := fileIdentity(t, filepath.Join(dir, "credentials.lock"))
	f.mu.Lock()
	f.access = "rotated-elsewhere"
	f.mu.Unlock()
	execute(t, app, "jobs", "get", "job-1")
	assertSameFile(t, filepath.Join(dir, "credentials.lock"), lockID, "second refresh")

	if r := execute(t, app, "auth", "logout"); r.code != ExitOK {
		t.Fatalf("logout = %d %s", r.code, r.stdout)
	}
	assertSameFile(t, creds, credsID, "logout")
	if _, err := app.Store.Load(); err != auth.ErrNotFound {
		t.Fatalf("still signed in after logout: %v", err)
	}
	if status := execute(t, app, "auth", "status"); status.out["data"].(map[string]any)["state"] != "unauthenticated" {
		t.Fatalf("status after logout = %s", status.stdout)
	}

	login(t, app)
	assertSameFile(t, creds, credsID, "second login")
	if left, _ := filepath.Glob(filepath.Join(dir, ".tmp-*")); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

// Deleting is what a sandbox asks about, so signing in never deletes. Leftovers from earlier
// versions are counted by `auth status` and removed by an explicit `auth logout`.
func TestLeftoverTemporaryFilesAreReportedAndRemovedOnlyByLogout(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	leftovers := []string{filepath.Join(dir, ".tmp-1111"), filepath.Join(dir, ".tmp-2222")}
	for _, path := range leftovers {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	app := newApp(t, f, dir)
	login(t, app)
	for _, path := range leftovers {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("signing in deleted %s", filepath.Base(path))
		}
	}
	if data := execute(t, app, "auth", "status").out["data"].(map[string]any); data["leftover_temp_files"] != float64(2) {
		t.Fatalf("status = %v", data)
	}
	execute(t, app, "auth", "logout")
	if left, _ := filepath.Glob(filepath.Join(dir, ".tmp-*")); len(left) != 0 {
		t.Fatalf("leftovers remain after logout: %v", left)
	}
	if data := execute(t, app, "auth", "status").out["data"].(map[string]any); data["leftover_temp_files"] != nil {
		t.Fatalf("status still reports leftovers: %v", data)
	}
}

func TestStatusSaysWhyTheKeychainIsNotUsed(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	app.Store = auth.Store{Dir: app.Store.Dir, UseKeyring: true, Keychain: refusingKeychain{}}
	login(t, app)
	data := execute(t, app, "auth", "status").out["data"].(map[string]any)
	if data["credential_store"] != "file" || data["credential_store_issue"] != "unavailable" || data["state"] != "ready" {
		t.Fatalf("status = %v", data)
	}
}

type refusingKeychain struct{}

func (refusingKeychain) Get(string, string) (string, error) { return "", errors.New("denied") }
func (refusingKeychain) Set(string, string, string) error   { return errors.New("denied") }
func (refusingKeychain) Delete(string, string) error        { return errors.New("denied") }

func TestTheSubmissionRecordIsUpdatedInPlace(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	args := []string{"images", "create", "--prompt", "a fox", "--idempotency-key", "same-key-12345"}
	if r := execute(t, app, args...); r.code != ExitOK {
		t.Fatalf("create = %d %s", r.code, r.stdout)
	}
	records, _ := filepath.Glob(filepath.Join(dir, "submissions", "*.json"))
	if len(records) != 1 {
		t.Fatalf("records = %v", records)
	}
	before := fileIdentity(t, records[0])
	if r := execute(t, app, args...); r.code != ExitOK {
		t.Fatalf("second create = %d %s", r.code, r.stdout)
	}
	assertSameFile(t, records[0], before, "a repeated submission")
}

// A keychain error that carries a local path.
type leakyKeychain struct{ holds bool }

func (k leakyKeychain) Get(string, string) (string, error) {
	if k.holds {
		return `{"access_token":"a","refresh_token":"r","base_url":"http://x"}`, nil
	}
	return "", errors.New("User interaction is not allowed: /Users/someone/Library/Keychains/login.keychain")
}
func (leakyKeychain) Set(string, string, string) error {
	return errors.New("User interaction is not allowed: /Users/someone/Library/Keychains/login.keychain")
}
func (leakyKeychain) Delete(string, string) error {
	return errors.New("User interaction is not allowed: /Users/someone/Library/Keychains/login.keychain")
}

func TestStoreFailuresNeverEchoTheStoresOwnText(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	// The keychain still holds the login but refuses to let go of it.
	app.Store = auth.Store{Dir: dir, UseKeyring: true, Keychain: leakyKeychain{holds: true}}
	r := execute(t, app, "auth", "logout")
	if r.code == ExitOK {
		t.Fatalf("logout succeeded although the keychain kept the login: %s", r.stdout)
	}
	if strings.Contains(r.stdout, "someone") || strings.Contains(r.stdout, "keychain") && strings.Contains(r.stdout, "/Users") {
		t.Fatalf("the store's own error text leaked: %s", r.stdout)
	}
}

func TestAnUnreadableCredentialFileDoesNotEchoItsOwnText(t *testing.T) {
	f := newFakeServer(t)
	dir := t.TempDir()
	app := newApp(t, f, dir)
	login(t, app)
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{"refresh_token":"x","checksum":"bad"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "jobs", "get", "job-1")
	if r.code != ExitAuth || strings.Contains(r.stdout, "credentials.json") || strings.Contains(r.stdout, dir) {
		t.Fatalf("unreadable credentials = %d %s", r.code, r.stdout)
	}
}

// Everyone tries `-v` and `--version` first; the answer must be the version, not a usage error.
func TestVersionFlagsAreAliasesOfTheVersionCommand(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	want := execute(t, app, "version").out["data"]
	for _, flag := range []string{"-v", "-V", "--version"} {
		r := execute(t, app, flag)
		if r.code != ExitOK || r.out["ok"] != true {
			t.Fatalf("%s = %d %s", flag, r.code, r.stdout)
		}
		got := r.out["data"].(map[string]any)
		if got["version"] != Version || got["version"] != want.(map[string]any)["version"] {
			t.Fatalf("%s reported %v, want %v", flag, got, want)
		}
	}
	// Anything else is still a usage error, and `-v` is only the version when it stands alone.
	if r := execute(t, app, "-x"); r.code != ExitInvalid {
		t.Fatalf("an unknown flag = %d %s", r.code, r.stdout)
	}
	if r := execute(t, app, "jobs", "-v"); r.code == ExitOK {
		t.Fatalf("`jobs -v` was accepted: %s", r.stdout)
	}
}

// A refresh whose identity cannot be stored first is never sent: the refresh token would be
// spent with nothing to repeat it by.
func TestARefreshThatCannotBeRepeatedIsNotSent(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("file permissions are not enforced here")
	}
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.access = "rotated-elsewhere"
	f.mu.Unlock()
	path := filepath.Join(app.Store.Dir, "credentials.json")
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	r := execute(t, app, "jobs", "get", "job-1")
	if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "CREDENTIAL_STORE_UNWRITABLE" {
		t.Fatalf("refresh with an unwritable store = %d %s", r.code, r.stdout)
	}
	if f.refreshCalls != 0 {
		t.Fatalf("sent a refresh it could not repeat: %d", f.refreshCalls)
	}
}

func TestARecoveredExpiredAccessTokenIsRotatedAgain(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.access, f.expiredOnce = "rotated-elsewhere", true
	f.mu.Unlock()
	if r := execute(t, app, "jobs", "get", "job-1"); r.code != ExitOK {
		t.Fatalf("command = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshCalls != 2 || f.refreshRequestIDs[0] == f.refreshRequestIDs[1] {
		t.Fatalf("refreshes = %d %q", f.refreshCalls, f.refreshRequestIDs)
	}
	creds, _ := app.Store.Load()
	if creds.RefreshToken != "refresh-1-next-next" || creds.RefreshRequestID != "" || !time.Now().Before(creds.AccessExpiresAt) {
		t.Fatalf("stored = %+v", creds)
	}
}

// Against a service that predates request identities, a redeemed code cannot be repeated: the
// next login says so and a fresh login works.
func TestAFailedSaveAgainstAnOlderServiceAsksForANewApproval(t *testing.T) {
	f := newFakeServer(t)
	f.ignoreRequestID = true
	app := newApp(t, f, t.TempDir())
	creds := filepath.Join(app.Store.Dir, "credentials.json")
	f.onRedeem = func() {
		_ = os.Remove(creds)
		_ = os.Mkdir(creds, 0o700)
		_ = os.WriteFile(filepath.Join(creds, "block"), []byte("block"), 0o600)
	}
	execute(t, app, "auth", "login")
	f.mu.Lock()
	f.onRedeem = nil
	f.mu.Unlock()
	if err := os.RemoveAll(creds); err != nil {
		t.Fatal(err)
	}
	if status := execute(t, app, "auth", "status"); status.out["data"].(map[string]any)["pending_login"] == nil {
		t.Fatalf("status hides the recoverable login: %s", status.stdout)
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitAuth || r.out["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
		t.Fatalf("second login = %d %s", r.code, r.stdout)
	}
	login(t, app)
}

func TestARedeemedLoginPastItsCodeLifetimeStillChecksTheService(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	other := newFakeServer(t)
	pending := auth.PendingLogin{
		DeviceCode: "other-code", UserCode: "BCDF-GHJK", ExpiresAt: time.Now().Add(-time.Minute),
		IntervalSeconds: 1, BaseURL: other.server.URL, RequestID: "11111111-1111-4111-8111-111111111111", Redeemed: true,
	}
	if err := app.Store.SavePending(pending); err != nil {
		t.Fatal(err)
	}
	app.APIURL = other.server.URL
	r := execute(t, app, "auth", "login")
	if r.out["error"].(map[string]any)["code"] != "SERVICE_MISMATCH" {
		t.Fatalf("login = %s", r.stdout)
	}
	if other.polls != 0 {
		t.Fatal("redeemed a login for another service without being asked")
	}
}
