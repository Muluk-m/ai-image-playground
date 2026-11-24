package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

func init() {
	// Tests must not sleep for the production retry pause.
	readonlyRetryWait = 0
}

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
	// artifactType is the content type of the generated artifact; empty means image/png.
	artifactType string
	// ignoreRequestID behaves like a service that predates request identities.
	ignoreRequestID bool
	// expiredOnce answers the next refresh with an access token that has no lifetime left.
	expiredOnce bool
	// twoArtifacts makes a succeeded job have two results; failArtifact makes that one's
	// download link fail; failJobPoll makes every job poll fail.
	quotaUsedUp  bool
	submitCalls  int
	twoArtifacts bool
	failArtifact string
	failJobPoll  bool
	// serveFile replaces the storage handler for downloads and uploads when set.
	serveFile http.HandlerFunc
	// meFails, capFails, validateFails and getFails are remaining 503s to emit
	// before the corresponding read-only endpoint succeeds. 0 means healthy.
	meFails       int
	capFails      int
	validateFails int
	getFails      int
	meCalls       int
	capCalls      int
	// Loopback sign-in as the service sees it: what the CLI registered, and the code it issued.
	redirectURI   string
	codeChallenge string
	issuedCode    string
	codeExchanges int
	codeBusy      bool
}

const secretDeviceCode = "device-secret-value"

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{t: t, approveAfter: 2, access: "access-1", refresh: "refresh-1", submissions: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/oauth/device_authorization", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.deviceRedeemed = false
		f.deviceAuthCalls++
		f.redirectURI, f.codeChallenge = r.Form.Get("redirect_uri"), r.Form.Get("code_challenge")
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
		case "authorization_code":
			f.codeExchanges++
			if f.codeBusy {
				f.codeBusy = false
				writeJSON(w, 503, map[string]string{"error": "temporarily_unavailable"})
				return
			}
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if f.issuedCode == "" || r.Form.Get("code") != f.issuedCode || f.deviceRedeemed ||
				r.Form.Get("redirect_uri") != f.redirectURI ||
				base64.RawURLEncoding.EncodeToString(sum[:]) != f.codeChallenge {
				writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
				return
			}
			f.deviceRedeemed = true
			writeJSON(w, 200, f.tokens())
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
		f.mu.Lock()
		f.meCalls++
		fail := f.meFails > 0
		if fail {
			f.meFails--
		}
		f.mu.Unlock()
		if fail {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		envelope(w, 200, map[string]any{"account": map[string]any{"id": "u1", "username": "fox"}, "credits": 42, "member": false, "min_cli_version": "0.1.0"}, "")
	}))
	mux.HandleFunc("GET /v1/capabilities", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.capCalls++
		fail := f.capFails > 0
		if fail {
			f.capFails--
		}
		f.mu.Unlock()
		if fail {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		envelope(w, 200, map[string]any{
			"models": []any{
				map[string]any{
					"id":                 "gpt-image-2.5-flare",
					"label":              "GPT Image 2.5 Flare",
					"default_image_size": "1K",
					"qualities":          []any{"medium"},
				},
			},
			"default_model": "gpt-image-2.5-flare",
		}, "")
	}))
	mux.HandleFunc("POST /v1/image-jobs/validate", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		fail := f.validateFails > 0
		if fail {
			f.validateFails--
		}
		f.mu.Unlock()
		if fail {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		envelope(w, 200, map[string]any{"credits": 1, "charged": false}, "")
	}))
	mux.HandleFunc("POST /v1/image-jobs", authed(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		key, _ := body["idempotency_key"].(string)
		encoded, _ := json.Marshal(body)
		f.mu.Lock()
		f.submissions[key] = string(encoded)
		f.submitCalls++
		quotaUsedUp := f.quotaUsedUp
		fail := f.failSubmits > 0
		if fail {
			f.failSubmits--
		}
		f.mu.Unlock()
		if quotaUsedUp {
			writeJSON(w, 429, map[string]any{"schema_version": 1, "ok": false, "error": map[string]any{
				"code": "QUOTA_EXCEEDED", "message": "The daily generation quota is used up",
				"details": map[string]any{"reset_at": "2099-01-01T00:00:00.000Z"},
			}})
			return
		}
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
		failPoll := f.failJobPoll
		failOnce := f.getFails > 0
		if failOnce {
			f.getFails--
		}
		f.mu.Unlock()
		if failPoll || failOnce {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		if !done {
			envelope(w, 200, map[string]any{"job_id": "job-1", "status": "running", "terminal": false, "next_poll_after_seconds": 2}, "")
			return
		}
		if f.failJob {
			envelope(w, 200, map[string]any{"job_id": "job-1", "status": "failed", "terminal": true, "error": map[string]any{"code": "upstream_error", "message": "The model failed"}}, "")
			return
		}
		artifacts := []any{map[string]any{"artifact_id": "art_job-1_0", "media_id": "m1", "content_type": f.contentType()}}
		if f.twoArtifacts {
			artifacts = append(artifacts, map[string]any{"artifact_id": "art_job-1_1", "media_id": "m2", "content_type": f.contentType()})
		}
		envelope(w, 200, map[string]any{"job_id": "job-1", "status": "succeeded", "terminal": true, "artifacts": artifacts}, "")
	}))
	mux.HandleFunc("GET /v1/artifacts/{id}/download", authed(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		failing := f.failArtifact
		f.mu.Unlock()
		if r.PathValue("id") == failing {
			envelope(w, 503, nil, "TEMPORARILY_UNAVAILABLE")
			return
		}
		envelope(w, 200, map[string]any{"download_url": f.server.URL + "/files/a.png", "content_type": f.contentType()}, "")
	}))
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		custom := f.serveFile
		f.mu.Unlock()
		if custom != nil {
			custom(w, r)
			return
		}
		_, _ = w.Write([]byte("PNGDATA"))
	})
	mux.HandleFunc("POST /v1/media", authed(func(w http.ResponseWriter, r *http.Request) {
		envelope(w, 200, map[string]any{"media_id": "m-up", "status": "pending", "upload_url": f.server.URL + "/files/upload"}, "")
	}))
	mux.HandleFunc("POST /v1/media/{id}/complete", authed(func(w http.ResponseWriter, r *http.Request) {
		envelope(w, 200, map[string]any{"media_id": r.PathValue("id"), "status": "ready"}, "")
	}))
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeServer) contentType() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.artifactType == "" {
		return "image/png"
	}
	return f.artifactType
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
		// No browser in tests unless one opts in: the link is printed instead.
		OpenBrowser: func(string) error { return errors.New("no browser") },
	}
}

// approveInBrowser plays the user's browser: the page approves, then sends the browser back to
// the CLI's callback with the code the service issued. It returns where the CLI sent it next.
func (f *fakeServer) approveInBrowser(t *testing.T, opened string) string {
	t.Helper()
	target, err := url.Parse(opened)
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.issuedCode = "one-time-code"
	redirect := f.redirectURI
	f.mu.Unlock()
	browser := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := browser.Get(redirect + "?code=one-time-code&state=" + url.QueryEscape(target.Query().Get("state")))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.Header.Get("Location")
}

func execute(t *testing.T, app *App, args ...string) run {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app.Out, app.Err = &stdout, &stderr
	code := app.Run(append([]string{"--json"}, args...))
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
	if !strings.Contains(r.stderr, f.server.URL+"/device?user_code=BCDF-GHJK") || strings.Contains(r.stderr, "(code ") {
		t.Fatalf("stderr should show only the approval link without a separate code, got %q", r.stderr)
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
	if r.code != ExitOK || data["state"] != "pending" || data["verification_uri_complete"] != f.server.URL+"/device?user_code=BCDF-GHJK" {
		t.Fatalf("no-wait = %d %s", r.code, r.stdout)
	}
	if _, hasCode := data["user_code"]; hasCode {
		t.Fatalf("no-wait should not expose user_code separately: %s", r.stdout)
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
	// The same bytes already in place count as downloaded; other bytes are never replaced.
	same := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", saved)
	if same.code != ExitOK || same.out["data"].(map[string]any)["already_present"] != true {
		t.Fatalf("same file = %d %s", same.code, same.stdout)
	}
	other := filepath.Join(out, "mine.png")
	if err := os.WriteFile(other, []byte("MY OWN PICTURE"), 0o644); err != nil {
		t.Fatal(err)
	}
	again := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", other)
	if again.code != ExitRejected || again.out["error"].(map[string]any)["code"] != "FILE_EXISTS" {
		t.Fatalf("overwrite attempt = %d %s", again.code, again.stdout)
	}
	if content, _ := os.ReadFile(other); string(content) != "MY OWN PICTURE" {
		t.Fatal("an existing file was replaced")
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

func TestSkillInstallGenericAndRejectedHosts(t *testing.T) {
	dir := t.TempDir()
	app := newApp(t, newFakeServer(t), dir)
	app.CWD = dir
	if r := execute(t, app, "skill", "install", "--host", "doubao"); r.code != ExitInvalid {
		t.Fatalf("doubao host = %d %s", r.code, r.stdout)
	}
	if r := execute(t, app, "skill", "install", "--host", "workbuddy"); r.code != ExitOK {
		t.Fatalf("workbuddy host = %d %s", r.code, r.stdout)
	}
	if _, err := os.Stat(filepath.Join(app.Home, ".workbuddy", "skills", "muvloom", "SKILL.md")); err != nil {
		t.Fatalf("workbuddy SKILL.md not installed: %v", err)
	}
	if r := execute(t, app, "skill", "install", "--host", "claude-code", "--output", dir); r.code != ExitInvalid {
		t.Fatalf("output on claude-code = %d %s", r.code, r.stdout)
	}
	r := execute(t, app, "skill", "install", "--host", "generic", "--output", dir)
	if r.code != ExitOK {
		t.Fatalf("generic install = %d %s", r.code, r.stdout)
	}
	if _, err := os.Stat(filepath.Join(dir, "muvloom", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

func TestSkillInstallDirIsTrackedAndShowPrintsTheSkill(t *testing.T) {
	dir := t.TempDir()
	app := newApp(t, newFakeServer(t), dir)
	skills := filepath.Join(t.TempDir(), "agent-skills")
	if r := execute(t, app, "skill", "install", "--dir", skills, "--host", "codex"); r.code != ExitInvalid {
		t.Fatalf("--dir with --host = %d %s", r.code, r.stdout)
	}
	r := execute(t, app, "skill", "install", "--dir", skills)
	if r.code != ExitOK || r.out["data"].(map[string]any)["path"] != filepath.Join(skills, "muvloom") {
		t.Fatalf("--dir install = %d %s", r.code, r.stdout)
	}
	status := execute(t, app, "skill", "status")
	installed := status.out["data"].(map[string]any)["installed"].([]any)
	if len(installed) != 1 || installed[0].(map[string]any)["host"] != "custom" || installed[0].(map[string]any)["current"] != true {
		t.Fatalf("status after --dir install = %s", status.stdout)
	}

	shown := execute(t, app, "skill", "show")
	content, _ := shown.out["data"].(map[string]any)["content"].(string)
	bundled, err := os.ReadFile(filepath.Join(skills, "muvloom", "SKILL.md"))
	if err != nil || shown.code != ExitOK || !strings.Contains(content, string(bundled)) {
		t.Fatalf("skill show = %d, SKILL.md included = %v", shown.code, strings.Contains(content, string(bundled)))
	}
	var text bytes.Buffer
	app.Out = &text
	if code := app.Run([]string{"skill", "show"}); code != ExitOK || !strings.HasPrefix(text.String(), "<!-- muvloom skill file: SKILL.md -->\n") {
		t.Fatalf("text skill show = %d %.80q", code, text.String())
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
	pending, err := app.Store.LoadPending()
	if err != nil || !pending.Redeemed {
		t.Fatalf("pending login after a failed save = %+v %v", pending, err)
	}
	// Even after the code itself expired, and even if marking it redeemed never reached the disk.
	pending.ExpiresAt = time.Now().Add(-time.Minute)
	pending.Redeemed = false
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

func TestReadonlyCommandsRetryOnceOnATransientError(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.meFails, f.capFails, f.validateFails = 1, 1, 1
	f.mu.Unlock()

	status := execute(t, app, "auth", "status")
	data := status.out["data"].(map[string]any)
	if status.code != ExitOK || data["state"] != "ready" {
		t.Fatalf("status after one 503 = %d %s", status.code, status.stdout)
	}
	if r := execute(t, app, "capabilities"); r.code != ExitOK {
		t.Fatalf("capabilities after one 503 = %d %s", r.code, r.stdout)
	}
	if r := execute(t, app, "images", "validate", "--prompt", "setup smoke"); r.code != ExitOK {
		t.Fatalf("validate after one 503 = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.meCalls < 2 || f.capCalls < 2 {
		t.Fatalf("read-only calls were not retried: me=%d cap=%d", f.meCalls, f.capCalls)
	}
}

func TestReadonlyCommandsDoNotRetryAPersistentOutage(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	login(t, app)
	f.mu.Lock()
	f.meFails, f.capFails = 5, 5
	f.mu.Unlock()

	status := execute(t, app, "auth", "status")
	data := status.out["data"].(map[string]any)
	if status.code != ExitOK || data["state"] != "unreachable" {
		t.Fatalf("status during a persistent outage = %d %s", status.code, status.stdout)
	}
	if r := execute(t, app, "capabilities"); r.code != ExitTemporary {
		t.Fatalf("capabilities during a persistent outage = %d %s", r.code, r.stdout)
	}
	// The existing connection must stay put: unreachable is not a reason to log in again.
	if creds, err := app.Store.Load(); err != nil || creds.RefreshToken != "refresh-1" {
		t.Fatalf("the connection was not kept: %v", err)
	}
}

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

// An expired login that was never approved: the service declines to repeat it, and the same
// command goes on to a new approval instead of failing.
func TestAnExpiredUnapprovedLoginStartsANewOne(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	execute(t, app, "auth", "login", "--no-wait")
	pending, _ := app.Store.LoadPending()
	pending.ExpiresAt = time.Now().Add(-time.Minute)
	if err := app.Store.SavePending(pending); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.deviceError = "expired_token"
	f.mu.Unlock()
	r := execute(t, app, "auth", "login", "--no-wait")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "pending" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deviceAuthCalls != 2 {
		t.Fatalf("device authorizations = %d, want a new one", f.deviceAuthCalls)
	}
	next, _ := app.Store.LoadPending()
	if next.RequestID == "" || next.RequestID == pending.RequestID {
		t.Fatalf("the new login reused the old identity")
	}
}

func TestABusyServiceKeepsARecoverableLogin(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	execute(t, app, "auth", "login", "--no-wait")
	pending, _ := app.Store.LoadPending()
	pending.ExpiresAt = time.Now().Add(-time.Minute)
	if err := app.Store.SavePending(pending); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.deviceError = "temporarily_unavailable"
	f.mu.Unlock()
	r := execute(t, app, "auth", "login")
	if r.code != ExitTemporary || r.out["error"].(map[string]any)["code"] != "TEMPORARILY_UNAVAILABLE" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	kept, _ := app.Store.LoadPending()
	if kept.RequestID != pending.RequestID || kept.DeviceCode != pending.DeviceCode || f.deviceAuthCalls != 1 {
		t.Fatalf("the recoverable login was replaced: %d authorizations", f.deviceAuthCalls)
	}
}

func slowSleep(ctx context.Context, d time.Duration) error {
	select {
	case <-time.After(10 * time.Millisecond):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// One command: it opens the browser itself, and the approval brings the browser straight back,
// so the login finishes without polling or a reply from the user.
func TestLoginOpensTheBrowserAndFinishesFromTheCallback(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 1 << 30 // the device code never completes: only the callback can
	app := newApp(t, f, t.TempDir())
	app.Sleep = slowSleep
	landed := make(chan string, 1)
	var opened string
	app.OpenBrowser = func(u string) error {
		opened = u
		go func() { landed <- f.approveInBrowser(t, u) }()
		return nil
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if !strings.Contains(opened, "user_code=BCDF-GHJK") || !strings.Contains(opened, "state=") {
		t.Fatalf("opened %q", opened)
	}
	if strings.Contains(r.stderr, f.server.URL+"/device") {
		t.Fatalf("printed the link although the browser opened: %s", r.stderr)
	}
	if got := <-landed; got != f.server.URL+"/device?status=connected" {
		t.Fatalf("browser sent to %q", got)
	}
	if !strings.HasPrefix(f.redirectURI, "http://127.0.0.1:") || f.codeChallenge == "" || f.codeExchanges != 1 {
		t.Fatalf("registered %q %q, exchanges %d", f.redirectURI, f.codeChallenge, f.codeExchanges)
	}
	assertNoSecrets(t, r, "one-time-code", secretDeviceCode, "refresh-1")
}

func TestACallbackForAnotherLoginIsTurnedAway(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 5
	app := newApp(t, f, t.TempDir())
	app.Sleep = slowSleep
	status := make(chan int, 1)
	app.OpenBrowser = func(string) error {
		go func() {
			f.mu.Lock()
			redirect := f.redirectURI
			f.mu.Unlock()
			res, err := http.Get(redirect + "?code=forged&state=not-this-login")
			if err == nil {
				res.Body.Close()
				status <- res.StatusCode
			}
		}()
		return nil
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if got := <-status; got != http.StatusBadRequest {
		t.Fatalf("forged callback = %d", got)
	}
	if f.codeExchanges != 0 {
		t.Fatal("exchanged a code from a callback that did not belong to this login")
	}
}

// A port that cannot be opened leaves the device code alone: the same command still opens the
// browser and completes once the user approves.
func TestLoginFallsBackToTheDeviceCodeWhenItCannotListen(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	app.Listen = func(string, string) (net.Listener, error) { return nil, errors.New("blocked") }
	var opened string
	app.OpenBrowser = func(u string) error { opened = u; return nil }
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if f.redirectURI != "" || f.codeChallenge != "" {
		t.Fatalf("registered a callback it could not serve: %q", f.redirectURI)
	}
	if opened != f.server.URL+"/device?user_code=BCDF-GHJK" {
		t.Fatalf("opened %q", opened)
	}
}

func TestLoginPrintsTheLinkWhenTheBrowserCannotOpen(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || !strings.Contains(r.stderr, f.server.URL+"/device?user_code=BCDF-GHJK") {
		t.Fatalf("login = %d, stderr %q", r.code, r.stderr)
	}
}

// Waiting timed out; running the command again continues the same login: no new approval page,
// and the page already open still brings the browser back to this machine.
func TestAResumedLoginReusesTheOpenPage(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 1 << 30
	app := newApp(t, f, t.TempDir())
	app.OpenBrowser = func(string) error { return nil }
	if r := execute(t, app, "auth", "login", "--timeout", "0"); r.out["error"].(map[string]any)["code"] != "AUTH_PENDING" {
		t.Fatalf("first login = %s", r.stdout)
	}
	pending, _ := app.Store.LoadPending()
	opens := 0
	landed := make(chan string, 1)
	app.Sleep = slowSleep
	app.OpenBrowser = func(string) error { opens++; return nil }
	var addr string
	app.Listen = func(network, a string) (net.Listener, error) {
		addr = a
		l, err := net.Listen(network, a)
		if err == nil {
			go func() { landed <- f.approveInBrowser(t, approvalURL(pending)) }()
		}
		return l, err
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("resumed login = %d %s", r.code, r.stdout)
	}
	if opens != 0 || f.deviceAuthCalls != 1 {
		t.Fatalf("opened %d pages, %d authorizations", opens, f.deviceAuthCalls)
	}
	if !strings.HasSuffix(pending.RedirectURI, addr+"/callback") {
		t.Fatalf("listened on %q, registered %q", addr, pending.RedirectURI)
	}
	if got := <-landed; got != f.server.URL+"/device?status=connected" {
		t.Fatalf("browser sent to %q", got)
	}
}

// The code exchange hit a temporary error and is retried with the same code: the browser waits
// for that outcome and is told it connected, not that it failed.
func TestABrowserWaitsForTheLoginWhenTheCodeExchangeIsBusy(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 1 << 30
	f.codeBusy = true
	app := newApp(t, f, t.TempDir())
	landed := make(chan string, 1)
	polls := 0
	app.Sleep = func(ctx context.Context, d time.Duration) error {
		polls++
		if polls == 20 {
			f.mu.Lock()
			f.approveAfter = 0
			f.mu.Unlock()
		}
		return slowSleep(ctx, d)
	}
	app.OpenBrowser = func(u string) error {
		go func() { landed <- f.approveInBrowser(t, u) }()
		return nil
	}
	r := execute(t, app, "auth", "login")
	if r.code != ExitOK || r.out["data"].(map[string]any)["state"] != "ready" {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if got := <-landed; got != f.server.URL+"/device?status=connected" {
		t.Fatalf("browser sent to %q", got)
	}
}

// A pending login whose stored callback was edited to a non-loopback address is never served
// there: the login still finishes by polling.
func TestAResumedLoginNeverListensOffLoopback(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	execute(t, app, "auth", "login", "--no-wait")
	pending, _ := app.Store.LoadPending()
	pending.RedirectURI, pending.State, pending.CodeVerifier = "http://0.0.0.0:53682/callback", "s", "v"
	if err := app.Store.SavePending(pending); err != nil {
		t.Fatal(err)
	}
	var addrs []string
	app.Listen = func(network, addr string) (net.Listener, error) {
		addrs = append(addrs, addr)
		return net.Listen(network, addr)
	}
	if r := execute(t, app, "auth", "login"); r.code != ExitOK {
		t.Fatalf("login = %d %s", r.code, r.stdout)
	}
	if len(addrs) != 0 {
		t.Fatalf("listened on %v", addrs)
	}
}

// A GIF request carries its format and frame settings, and the download keeps a .gif name.
func TestANativeGifIsRequestedAndSavedAsGif(t *testing.T) {
	for _, tc := range []struct{ format, contentType, ext string }{
		{"gif", "image/gif", ".gif"},
		{"svg", "image/svg+xml", ".svg"},
	} {
		t.Run(tc.format, func(t *testing.T) {
			f := newFakeServer(t)
			f.artifactType = tc.contentType
			app := newApp(t, f, t.TempDir())
			login(t, app)
			out := t.TempDir()
			args := []string{"images", "create", "--prompt", "a dancing cat", "--model", "gpt-image-2.6-flare",
				"--output-format", tc.format, "--idempotency-key", "native-key-" + tc.format, "--wait", "60", "--download", out}
			if tc.format == "gif" {
				args = append(args, "--frames", "9", "--frame-duration-ms", "100", "--frame-size", "512x512")
			}
			r := execute(t, app, args...)
			if r.code != ExitOK {
				t.Fatalf("create = %d %s", r.code, r.stdout)
			}
			var sent map[string]any
			f.mu.Lock()
			_ = json.Unmarshal([]byte(f.submissions["native-key-"+tc.format]), &sent)
			f.mu.Unlock()
			if sent["output_format"] != tc.format {
				t.Fatalf("sent %v", sent)
			}
			if tc.format == "gif" && (sent["frame_count"] != float64(9) || sent["frame_duration_ms"] != float64(100) || sent["frame_size"] != "512x512") {
				t.Fatalf("gif settings not sent: %v", sent)
			}
			if tc.format == "svg" && (sent["frame_count"] != nil || sent["frame_size"] != nil) {
				t.Fatalf("svg sent gif settings: %v", sent)
			}
			files, _ := filepath.Glob(filepath.Join(out, "*"+tc.ext))
			if len(files) != 1 {
				entries, _ := os.ReadDir(out)
				t.Fatalf("downloaded %v, want one %s", entries, tc.ext)
			}
		})
	}
}

// After the service accepted a create, a later failure still says which job it was, so the
// caller waits or downloads again instead of submitting (and paying) again.
func TestCreateFailuresAfterSubmitKeepTheJob(t *testing.T) {
	t.Run("waiting fails", func(t *testing.T) {
		f := newFakeServer(t)
		f.failJobPoll = true
		app := newApp(t, f, t.TempDir())
		login(t, app)
		r := execute(t, app, "images", "create", "--prompt", "a fox", "--idempotency-key", "keep-job-key-1", "--wait", "60")
		details, _ := r.out["error"].(map[string]any)["details"].(map[string]any)
		if r.code == ExitOK || details["job_id"] != "job-1" || details["idempotency_key"] != "keep-job-key-1" {
			t.Fatalf("wait failure = %d %s", r.code, r.stdout)
		}
	})
	t.Run("second download fails, then a rerun finishes", func(t *testing.T) {
		f := newFakeServer(t)
		f.twoArtifacts, f.failArtifact = true, "art_job-1_1"
		app := newApp(t, f, t.TempDir())
		login(t, app)
		out := t.TempDir()
		args := []string{"images", "create", "--prompt", "a fox", "--idempotency-key", "keep-job-key-2", "--wait", "60", "--download", out}
		r := execute(t, app, args...)
		details, _ := r.out["error"].(map[string]any)["details"].(map[string]any)
		saved, _ := details["downloads"].([]any)
		if r.code == ExitOK || details["job_id"] != "job-1" || details["failed_artifact_id"] != "art_job-1_1" || len(saved) != 1 {
			t.Fatalf("second download failure = %d %s", r.code, r.stdout)
		}
		if saved[0].(map[string]any)["path"] != filepath.Join(out, "art_job-1_0.png") {
			t.Fatalf("first file not reported: %v", saved)
		}
		// The same key again: the first file is already there, the second now downloads.
		f.mu.Lock()
		f.failArtifact = ""
		f.mu.Unlock()
		again := execute(t, app, args...)
		downloads, _ := again.out["data"].(map[string]any)["downloads"].([]any)
		if again.code != ExitOK || len(downloads) != 2 || downloads[0].(map[string]any)["already_present"] != true {
			t.Fatalf("rerun = %d %s", again.code, again.stdout)
		}
	})
	t.Run("a different file in the way, as text", func(t *testing.T) {
		f := newFakeServer(t)
		app := newApp(t, f, t.TempDir())
		login(t, app)
		out := t.TempDir()
		mine := filepath.Join(out, "art_job-1_0.png")
		if err := os.WriteFile(mine, []byte("MY OWN PICTURE"), 0o644); err != nil {
			t.Fatal(err)
		}
		args := []string{"images", "create", "--prompt", "a fox", "--idempotency-key", "keep-job-key-3", "--wait", "60", "--download", out}
		r := execute(t, app, args...)
		details, _ := r.out["error"].(map[string]any)["details"].(map[string]any)
		if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "FILE_EXISTS" ||
			details["job_id"] != "job-1" || details["path"] != mine {
			t.Fatalf("conflict = %d %s", r.code, r.stdout)
		}
		if content, _ := os.ReadFile(mine); string(content) != "MY OWN PICTURE" {
			t.Fatal("the user's file was replaced")
		}
		var stdout, stderr bytes.Buffer
		app.Out, app.Err = &stdout, &stderr
		if code := app.Run(args); code != ExitRejected || stdout.Len() != 0 {
			t.Fatalf("text conflict = %d %q", code, stdout.String())
		}
		for _, want := range []string{"(FILE_EXISTS)", "job_id: job-1", "idempotency_key: keep-job-key-3", "path: " + mine} {
			if !strings.Contains(stderr.String(), want) {
				t.Fatalf("text failure lacks %q:\n%s", want, stderr.String())
			}
		}
	})
	t.Run("the job fails", func(t *testing.T) {
		f := newFakeServer(t)
		f.failJob = true
		app := newApp(t, f, t.TempDir())
		login(t, app)
		r := execute(t, app, "images", "create", "--prompt", "a fox", "--idempotency-key", "keep-job-key-4", "--wait", "60")
		details, _ := r.out["error"].(map[string]any)["details"].(map[string]any)
		job, _ := details["job"].(map[string]any)
		if r.code != ExitRejected || details["job_id"] != "job-1" || details["idempotency_key"] != "keep-job-key-4" || job["status"] != "failed" {
			t.Fatalf("failed job = %d %s", r.code, r.stdout)
		}
	})
	t.Run("a dangling link in the way", func(t *testing.T) {
		f := newFakeServer(t)
		app := newApp(t, f, t.TempDir())
		login(t, app)
		out := t.TempDir()
		link := filepath.Join(out, "art_job-1_0.png")
		if err := os.Symlink(filepath.Join(out, "missing"), link); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
		r := execute(t, app, "images", "create", "--prompt", "a fox", "--idempotency-key", "keep-job-key-5", "--wait", "60", "--download", out)
		if r.code != ExitRejected || r.out["error"].(map[string]any)["code"] != "FILE_EXISTS" {
			t.Fatalf("dangling link = %d %s", r.code, r.stdout)
		}
		if _, err := os.Stat(filepath.Join(out, "missing")); !os.IsNotExist(err) {
			t.Fatal("wrote through the link")
		}
	})
}

// A used-up daily quota is not a busy signal: exit 5, one submit, the reset time reported.
func TestQuotaExceededIsNotRetriedAndSaysWhenItResets(t *testing.T) {
	f := newFakeServer(t)
	f.quotaUsedUp = true
	app := newApp(t, f, t.TempDir())
	login(t, app)
	r := execute(t, app, "images", "create", "--prompt", "a fox", "--idempotency-key", "quota-key-123")
	errObj, _ := r.out["error"].(map[string]any)
	details, _ := errObj["details"].(map[string]any)
	if r.code != ExitCredits || errObj["code"] != "QUOTA_EXCEEDED" || details["reset_at"] != "2099-01-01T00:00:00.000Z" {
		t.Fatalf("quota = %d %s", r.code, r.stdout)
	}
	f.mu.Lock()
	calls := f.submitCalls
	f.mu.Unlock()
	if calls != 1 {
		t.Fatalf("the CLI retried a used-up quota: %d submits", calls)
	}
	var stdout, stderr bytes.Buffer
	app.Out, app.Err = &stdout, &stderr
	if code := app.Run([]string{"images", "create", "--prompt", "a fox", "--idempotency-key", "quota-key-124"}); code != ExitCredits || stdout.Len() != 0 {
		t.Fatalf("text quota = %d %q", code, stdout.String())
	}
	for _, want := range []string{"(QUOTA_EXCEEDED)", "reset_at: 2099-01-01T00:00:00.000Z", "Do not retry"} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("text failure lacks %q:\n%s", want, stderr.String())
		}
	}
}

func TestApprovedPendingLoginIsCollectedAutomaticallyBySubsequentCommands(t *testing.T) {
	t.Run("business command collects approved login without re-running auth login", func(t *testing.T) {
		f := newFakeServer(t)
		f.approveAfter = 2
		app := newApp(t, f, t.TempDir())
		if r := execute(t, app, "auth", "login", "--no-wait"); r.code != ExitOK {
			t.Fatalf("no-wait = %d %s", r.code, r.stdout)
		}
		// Poll 1: user has not approved yet -> capabilities reports AUTH_REQUIRED and preserves pending-login.json.
		if r := execute(t, app, "capabilities"); r.code != ExitAuth || r.out["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
			t.Fatalf("unapproved capabilities = %d %s", r.code, r.stdout)
		}
		if _, err := app.Store.LoadPending(); err != nil {
			t.Fatalf("pending login was dropped before approval: %v", err)
		}
		// Advance past NextPollAt so Poll 2 runs without sleeping or waiting.
		_ = app.Store.UpdatePendingIfMatch(secretDeviceCode, func(p *auth.PendingLogin) { p.NextPollAt = time.Time{} })
		// Poll 2: user has now clicked Allow -> capabilities redeems the token on its own and succeeds.
		r := execute(t, app, "capabilities")
		if r.code != ExitOK {
			t.Fatalf("approved capabilities = %d %s %s", r.code, r.stdout, r.stderr)
		}
		if _, err := app.Store.LoadPending(); !errors.Is(err, auth.ErrNotFound) {
			t.Fatalf("pending login not cleared after collection: %v", err)
		}
		if creds, err := app.Store.Load(); err != nil || creds.RefreshToken == "" {
			t.Fatalf("credentials not persisted: %+v %v", creds, err)
		}
	})

	t.Run("auth status collects approved login and omits stale pending_login", func(t *testing.T) {
		f := newFakeServer(t)
		f.approveAfter = 2
		app := newApp(t, f, t.TempDir())
		if r := execute(t, app, "auth", "login", "--no-wait"); r.code != ExitOK {
			t.Fatalf("no-wait = %d %s", r.code, r.stdout)
		}
		// Poll 1: still pending -> status is unauthenticated and surfaces pending_login.
		first := execute(t, app, "auth", "status")
		firstData := first.out["data"].(map[string]any)
		if first.code != ExitOK || firstData["state"] != "unauthenticated" || firstData["pending_login"] == nil {
			t.Fatalf("unapproved status = %d %s", first.code, first.stdout)
		}
		_ = app.Store.UpdatePendingIfMatch(secretDeviceCode, func(p *auth.PendingLogin) { p.NextPollAt = time.Time{} })
		// Poll 2: approved -> status transitions directly to ready with no leftover pending_login.
		second := execute(t, app, "auth", "status")
		secondData := second.out["data"].(map[string]any)
		if second.code != ExitOK || secondData["state"] != "ready" {
			t.Fatalf("approved status = %d %s", second.code, second.stdout)
		}
		if _, hasPending := secondData["pending_login"]; hasPending {
			t.Fatalf("ready status still carries pending_login: %s", second.stdout)
		}
	})
}

func TestSetupCommandInstallsSkillLogsInAndValidatesInOneStep(t *testing.T) {
	f := newFakeServer(t)
	f.approveAfter = 1
	app := newApp(t, f, t.TempDir())
	app.APIURL = ""
	app.Getenv = func(k string) string {
		if k == "WORKBUDDY_SANDBOX" {
			return "1"
		}
		return ""
	}

	// 1. Reject unsupported --origin cleanly.
	bad := execute(t, app, "setup", "--origin", "https://evil.example.com")
	if bad.code != ExitInvalid {
		t.Fatalf("expected ExitInvalid for unsupported origin, got %d: %s", bad.code, bad.stdout)
	}

	// 2. --no-wait installs the WorkBuddy Skill and returns pending login.
	pendingRes := execute(t, app, "setup", "--origin", f.server.URL, "--no-wait")
	if pendingRes.code != ExitOK {
		t.Fatalf("setup --no-wait failed: %d %s %s", pendingRes.code, pendingRes.stdout, pendingRes.stderr)
	}
	pendingData := pendingRes.out["data"].(map[string]any)
	if pendingData["state"] != "pending" {
		t.Fatalf("expected pending state, got %s", pendingRes.stdout)
	}
	if _, err := os.Stat(filepath.Join(app.Home, ".workbuddy", "skills", "muvloom", "SKILL.md")); err != nil {
		t.Fatalf("setup did not install workbuddy Skill: %v", err)
	}

	// 3. Subsequent `setup` auto-collects the approved login, reads capabilities, and runs smoke_validate.
	app.APIURL = ""
	readyRes := execute(t, app, "setup", "--origin", f.server.URL)
	if readyRes.code != ExitOK {
		t.Fatalf("setup resume failed: %d %s %s", readyRes.code, readyRes.stdout, readyRes.stderr)
	}
	data := readyRes.out["data"].(map[string]any)
	if data["state"] != "ready" || data["credential_store"] != "file" || data["default_model"] == nil || data["models"] == nil || data["smoke_validate"] == nil {
		t.Fatalf("incomplete setup readiness summary: %s", readyRes.stdout)
	}

	// 4. Switching to a second service via `setup --origin <other> --switch-service --no-wait`
	// and resuming via `setup` completes without falsely reporting SERVICE_MISMATCH.
	f2 := newFakeServer(t)
	f2.approveAfter = 1
	app.HTTP = f2.server.Client()
	mismatch := execute(t, app, "setup", "--origin", f2.server.URL)
	if mismatch.code != ExitRejected || !strings.Contains(mismatch.stdout, "--switch-service") {
		t.Fatalf("expected SERVICE_MISMATCH naming --switch-service, got %d: %s", mismatch.code, mismatch.stdout)
	}
	switchPending := execute(t, app, "setup", "--origin", f2.server.URL, "--switch-service", "--no-wait")
	if switchPending.code != ExitOK {
		t.Fatalf("setup --switch-service --no-wait failed: %d %s", switchPending.code, switchPending.stdout)
	}
	app.APIURL = ""
	switched := execute(t, app, "setup")
	if switched.code != ExitOK || switched.out["data"].(map[string]any)["api_url"] != f2.server.URL {
		t.Fatalf("setup --switch-service resume failed: %d %s %s", switched.code, switched.stdout, switched.stderr)
	}

	// 5. Re-running `setup` preserves user-edited Skill files instead of clobbering them.
	wbSkillMd := filepath.Join(app.Home, ".workbuddy", "skills", "muvloom", "SKILL.md")
	origBytes, err := os.ReadFile(wbSkillMd)
	if err != nil {
		t.Fatal(err)
	}
	editedBytes := append(origBytes, []byte("\n<!-- user custom note -->\n")...)
	if err := os.WriteFile(wbSkillMd, editedBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	rerun := execute(t, app, "setup")
	if rerun.code != ExitOK {
		t.Fatalf("setup rerun failed: %d %s", rerun.code, rerun.stdout)
	}
	afterBytes, err := os.ReadFile(wbSkillMd)
	if err != nil || string(afterBytes) != string(editedBytes) {
		t.Fatalf("setup overwrote user-edited SKILL.md")
	}
}

func TestCollectPendingLoginRespectsNextPollAtAndSlowDown(t *testing.T) {
	var tokenCalls int
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/oauth/token":
			tokenCalls++
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"slow_down"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	home := t.TempDir()
	store := auth.Store{Dir: filepath.Join(home, "config")}
	if err := store.SavePending(auth.PendingLogin{
		DeviceCode:              "dev-slow",
		UserCode:                "ABCD-EFGH",
		VerificationURIComplete: srvURL + "/device?user_code=ABCD-EFGH",
		ExpiresAt:               time.Now().Add(10 * time.Minute),
		IntervalSeconds:         5,
		BaseURL:                 srvURL,
	}); err != nil {
		t.Fatal(err)
	}
	var slept []time.Duration
	app := &App{
		APIURL:       srvURL,
		apiURLSource: sourceEnvironment,
		Store:        store,
		Home:         home,
		CWD:          home,
		HTTP:         srv.Client(),
		Sleep: func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			return nil
		},
	}

	// First `auth status` tries collect once, gets `slow_down`, increments IntervalSeconds to 10, and persists NextPollAt.
	first := execute(t, app, "auth", "status")
	if first.code != ExitOK || tokenCalls != 1 {
		t.Fatalf("expected 1 token call on first status, got calls=%d code=%d", tokenCalls, first.code)
	}
	updatedPending, err := store.LoadPending()
	if err != nil || updatedPending.IntervalSeconds != 10 || !time.Now().Before(updatedPending.NextPollAt) {
		t.Fatalf("expected slow_down to persist IntervalSeconds=10 and future NextPollAt, got %+v err=%v", updatedPending, err)
	}

	// Immediate second `auth status` returns instantly (0 sleeps, 0 network calls) while NextPollAt is in the future.
	second := execute(t, app, "auth", "status")
	if second.code != ExitOK || tokenCalls != 1 || len(slept) != 0 {
		t.Fatalf("expected NextPollAt to skip without sleeping on background status, got calls=%d slept=%v", tokenCalls, slept)
	}

	// CommitPendingLogin drops redemption if `auth logout` cleared pending-login.json concurrently.
	_ = store.Clear()
	_, outcome, err := store.CommitPendingLogin("dev-slow", auth.Credentials{
		AccessToken:         "stale-at",
		RefreshToken:        "stale-rt",
		BaseURL:             srvURL,
		LoginDeviceCodeHash: deviceCodeHash("dev-slow"),
	})
	if err != nil || outcome != auth.PendingAborted {
		t.Fatalf("expected CommitPendingLogin to abort after concurrent logout, got outcome=%v err=%v", outcome, err)
	}
	if _, loadErr := store.Load(); !errors.Is(loadErr, auth.ErrNotFound) {
		t.Fatalf("concurrent logout was resurrected by stale CommitPendingLogin: %v", loadErr)
	}
}

func TestConcurrentCollectPendingLoginDoesNotRevokeCommittedSession(t *testing.T) {
	var revokeCalls int
	var firstCommitted bool
	var srvURL string
	home := t.TempDir()
	store := auth.Store{Dir: filepath.Join(home, "config")}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/oauth/token":
			// Simulate Process A winning CommitPendingLogin while Process B's idempotent redeem is in flight.
			if !firstCommitted {
				firstCommitted = true
				_, outcome, cErr := store.CommitPendingLogin("dev-concurrent", auth.Credentials{
					AccessToken:         "shared-access",
					RefreshToken:        "shared-refresh",
					AccessExpiresAt:     time.Now().Add(time.Hour),
					BaseURL:             srvURL,
					LoginDeviceCodeHash: deviceCodeHash("dev-concurrent"),
				})
				if cErr != nil || outcome != auth.PendingCommitted {
					t.Errorf("first CommitPendingLogin failed: outcome=%v err=%v", outcome, cErr)
				}
			}
			_, _ = w.Write([]byte(`{"access_token":"shared-access","refresh_token":"shared-refresh","expires_in":3600}`))
		case "/v1/oauth/revoke":
			revokeCalls++
			_, _ = w.Write([]byte(`{}`))
		case "/v1/me":
			envelope(w, 200, map[string]any{"account": map[string]any{"id": "u1", "username": "alice"}, "credits": 100, "member": false, "scopes": []string{"images:write"}, "min_cli_version": "0.2.5"}, "")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	if err := store.SavePending(auth.PendingLogin{
		DeviceCode:              "dev-concurrent",
		RequestID:               "11111111-2222-4333-8444-555555555555",
		UserCode:                "CONC-1234",
		VerificationURIComplete: srvURL + "/device?user_code=CONC-1234",
		ExpiresAt:               time.Now().Add(10 * time.Minute),
		IntervalSeconds:         5,
		BaseURL:                 srvURL,
	}); err != nil {
		t.Fatal(err)
	}

	app := &App{
		APIURL:       srvURL,
		apiURLSource: sourceEnvironment,
		Store:        store,
		Home:         home,
		CWD:          home,
		HTTP:         srv.Client(),
	}
	res := execute(t, app, "auth", "status")
	if res.code != ExitOK {
		t.Fatalf("expected auth status to succeed, got code=%d stderr=%s", res.code, res.stderr)
	}
	if revokeCalls != 0 {
		t.Fatalf("second concurrent collector revoked the shared session (%d revoke calls)", revokeCalls)
	}
	loaded, err := store.Load()
	if err != nil || loaded.RefreshToken != "shared-refresh" {
		t.Fatalf("expected shared-refresh to remain stored, got %+v err=%v", loaded, err)
	}
}

func TestSetupSmokeValidateUsesAccountCapabilitiesAndEmptyModelsFailCleanly(t *testing.T) {
	var emptyModels bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me":
			envelope(w, 200, map[string]any{"account": map[string]any{"id": "u1", "username": "freeuser"}, "credits": 20, "member": false, "scopes": []string{"images:write"}, "min_cli_version": "0.2.5"}, "")
		case "/v1/capabilities":
			if emptyModels {
				envelope(w, 200, map[string]any{"default_model": nil, "models": []any{}}, "")
				return
			}
			envelope(w, 200, map[string]any{
				"default_model": "gpt-image-free",
				"models": []any{
					map[string]any{
						"id":                 "gpt-image-free",
						"label":              "Free Model",
						"default_image_size": "1K",
						"qualities":          []any{"low", "medium"},
					},
				},
			}, "")
		case "/v1/image-jobs/validate":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "gpt-image-free" || body["image_size"] != "1K" || body["quality"] != "medium" {
				envelope(w, http.StatusForbidden, nil, "PLAN_REQUIRED")
				return
			}
			envelope(w, 200, map[string]any{"creates_job": false, "quote": map[string]any{"estimated_credits": 1}}, "")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	home := t.TempDir()
	store := auth.Store{Dir: filepath.Join(home, "config")}
	if err := store.Save(auth.Credentials{
		AccessToken:     "tok",
		RefreshToken:    "ref",
		AccessExpiresAt: time.Now().Add(time.Hour),
		BaseURL:         srv.URL,
	}); err != nil {
		t.Fatal(err)
	}

	app := &App{
		APIURL:       srv.URL,
		apiURLSource: sourceEnvironment,
		Store:        store,
		Home:         home,
		CWD:          home,
		HTTP:         srv.Client(),
	}
	res := execute(t, app, "setup", "--host", "claude-code")
	if res.code != ExitOK {
		t.Fatalf("expected setup smoke validate to use account capabilities, got code=%d out=%s err=%s", res.code, res.stdout, res.stderr)
	}

	emptyModels = true
	noModelRes := execute(t, app, "setup", "--host", "claude-code")
	if noModelRes.code != ExitRejected || !strings.Contains(noModelRes.stdout, "CAPABILITY_UNAVAILABLE") {
		t.Fatalf("expected CAPABILITY_UNAVAILABLE when account has 0 accessible models, got code=%d out=%s", noModelRes.code, noModelRes.stdout)
	}
}

// transferApp gives API calls a total timeout far below the transfer time, so only the idle
// limit can let a slow transfer finish.
func transferApp(t *testing.T, f *fakeServer) *App {
	t.Helper()
	app := newApp(t, f, t.TempDir())
	login(t, app)
	short := *f.server.Client()
	short.Timeout = 1500 * time.Millisecond
	app.HTTP = &short
	app.TransferIdle = time.Second
	return app
}

func TestSlowDownloadThatKeepsMovingFinishes(t *testing.T) {
	f := newFakeServer(t)
	f.serveFile = func(w http.ResponseWriter, r *http.Request) {
		for _, b := range []byte("PNGDATA-SLOW") {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond) // ~1.8s in total, past the 1.5s API timeout
		}
	}
	app := transferApp(t, f)
	target := filepath.Join(t.TempDir(), "slow.png")
	r := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", target)
	if r.code != ExitOK {
		t.Fatalf("slow download = %d %s", r.code, r.stdout)
	}
	if content, _ := os.ReadFile(target); string(content) != "PNGDATA-SLOW" {
		t.Fatalf("download = %q", content)
	}
}

func TestStalledDownloadIsATemporaryFailure(t *testing.T) {
	f := newFakeServer(t)
	f.serveFile = func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("PNG"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
	app := transferApp(t, f)
	target := filepath.Join(t.TempDir(), "stalled.png")
	r := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", target)
	if r.code != ExitTemporary || r.out["error"].(map[string]any)["code"] != "NETWORK_ERROR" {
		t.Fatalf("stalled download = %d %s", r.code, r.stdout)
	}
	if !strings.Contains(r.stdout, "stalled") {
		t.Fatalf("message should say the transfer stalled: %s", r.stdout)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a stalled download left a file behind")
	}
}

func TestDownloadWithNoResponseStallsAfterThePlainIdleLimit(t *testing.T) {
	f := newFakeServer(t)
	f.serveFile = func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }
	app := transferApp(t, f)
	r := execute(t, app, "artifacts", "download", "art_job-1_0", "--output", filepath.Join(t.TempDir(), "x.png"))
	// A download sends no body, so it must not get the upload's longer wait for the response.
	if r.code != ExitTemporary || !strings.Contains(r.stdout, "Download stalled: nothing moved for 1s") {
		t.Fatalf("download with no response = %d %s", r.code, r.stdout)
	}
}

func writeUpload(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ref.png")
	if err := os.WriteFile(path, bytes.Repeat([]byte("P"), 64<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// slowLink plays a slow uplink: each write sends at most 1 KiB and then takes 60ms, about
// 17 KiB/s. An 8 KiB write therefore takes ~480ms, longer than the idle limit, while bytes keep
// moving the whole time.
type slowLink struct{ net.Conn }

func (c slowLink) Write(b []byte) (int, error) {
	written := 0
	for written < len(b) {
		n, err := c.Conn.Write(b[written:min(written+1024, len(b))])
		written += n
		if err != nil {
			return written, err
		}
		time.Sleep(60 * time.Millisecond)
	}
	return written, nil
}

func TestSlowUploadThatKeepsMovingFinishes(t *testing.T) {
	f := newFakeServer(t)
	f.serveFile = func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}
	app := transferApp(t, f)
	app.TransferIdle = 400 * time.Millisecond
	slow := app.HTTP.Transport.(*http.Transport).Clone()
	slow.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return slowLink{conn}, nil
	}
	app.HTTP.Transport = slow
	path := filepath.Join(t.TempDir(), "ref.png")
	// 40 KiB at ~17 KiB/s is ~2.4s, past the 1.5s API timeout.
	if err := os.WriteFile(path, bytes.Repeat([]byte("P"), 40<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "media", "upload", path)
	if r.code != ExitOK || r.out["data"].(map[string]any)["status"] != "ready" {
		t.Fatalf("slow upload = %d %s", r.code, r.stdout)
	}
}

func TestTransferProgressRacingTheTimerNeverCancels(t *testing.T) {
	app := &App{HTTP: &http.Client{}, TransferIdle: 20 * time.Millisecond}
	moving := app.startTransfer(context.Background(), false)
	for end := time.Now().Add(300 * time.Millisecond); time.Now().Before(end); {
		moving.extend(moving.idle) // progress right around every expiry
		time.Sleep(5 * time.Millisecond)
	}
	if moving.stalled() || moving.ctx.Err() != nil {
		t.Fatal("a transfer that kept moving was cancelled")
	}
	moving.stop()
	if moving.stalled() {
		t.Fatal("stopping a transfer must not read as a stall")
	}
	moving.extend(time.Hour) // progress after stop is ignored

	idle := app.startTransfer(context.Background(), false)
	defer idle.stop()
	select {
	case <-idle.ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("an idle transfer was never cancelled")
	}
	if !idle.stalled() {
		t.Fatal("an idle transfer must end as stalled")
	}
}

func TestStalledUploadIsATemporaryFailure(t *testing.T) {
	f := newFakeServer(t)
	f.serveFile = func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done() // never answers
	}
	app := transferApp(t, f)
	r := execute(t, app, "media", "upload", writeUpload(t))
	if r.code != ExitTemporary || !strings.Contains(r.stdout, "Upload stalled: nothing moved for 4s") {
		t.Fatalf("stalled upload = %d %s", r.code, r.stdout)
	}
}
