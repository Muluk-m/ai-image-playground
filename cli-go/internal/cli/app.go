// Package cli implements the muvloom command line. stdout carries exactly one JSON
// envelope per invocation; progress and diagnostics go to stderr. Access and refresh
// tokens, the secret device_code and signed upload URLs never reach either stream. The
// user_code and its verification link are shown on purpose (RFC 8628 §3.3): approving
// them only links a session to the account of whoever approves it.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

// Version is overridden at release time with -ldflags "-X .../cli.Version=x.y.z".
var Version = "0.1.2"

const (
	DefaultAPIURL  = "https://api.muvloom.online"
	oauthClientID  = "muvloom-cli"
	schemaVersion  = 1
	userAgentProto = "muvloom-cli/"
)

// Exit codes are part of the CLI contract; the bundled Skill documents them.
const (
	ExitOK          = 0
	ExitInternal    = 1
	ExitInvalid     = 2
	ExitAuth        = 3
	ExitRejected    = 4
	ExitCredits     = 5
	ExitTemporary   = 6
	ExitVersion     = 7
	maxPollInterval = 10 * time.Second
)

var exitByCode = map[string]int{
	"INVALID_REQUEST":         ExitInvalid,
	"SERVICE_MISMATCH":        ExitRejected,
	"USAGE":                   ExitInvalid,
	"UNAUTHENTICATED":         ExitAuth,
	"AUTH_REQUIRED":           ExitAuth,
	"AUTH_PENDING":            ExitAuth,
	"AUTH_DENIED":             ExitAuth,
	"AUTH_EXPIRED":            ExitAuth,
	"FORBIDDEN":               ExitRejected,
	"PLAN_REQUIRED":           ExitRejected,
	"NOT_FOUND":               ExitRejected,
	"CONFLICT":                ExitRejected,
	"IDEMPOTENCY_CONFLICT":    ExitRejected,
	"JOB_NOT_CANCELLABLE":     ExitRejected,
	"MODEL_UNAVAILABLE":       ExitRejected,
	"CAPABILITY_UNAVAILABLE":  ExitRejected,
	"MEDIA_NOT_READY":         ExitRejected,
	"REQUEST_TOO_LARGE":       ExitRejected,
	"FILE_EXISTS":             ExitRejected,
	"JOB_FAILED":              ExitRejected,
	"JOB_CANCELED":            ExitRejected,
	"INSUFFICIENT_CREDITS":    ExitCredits,
	"MAX_CREDITS_EXCEEDED":    ExitCredits,
	"NETWORK_ERROR":           ExitTemporary,
	"RATE_LIMITED":            ExitTemporary,
	"TEMPORARILY_UNAVAILABLE": ExitTemporary,
	"INTERNAL_ERROR":          ExitTemporary,
	"UNSUPPORTED_VERSION":     ExitVersion,
	"UPGRADE_REQUIRED":        ExitVersion,
}

// Failure is a command error with a stable code, rendered as the error envelope.
type Failure struct {
	Code    string
	Message string
	Details any
}

func (f *Failure) Error() string { return f.Message }

func fail(code, format string, args ...any) *Failure {
	return &Failure{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Where the effective service address came from, reported by `auth status`.
const (
	sourceEnvironment = "environment"
	sourceConnection  = "connection"
	sourcePending     = "pending_login"
	sourceDefault     = "default"
)

type App struct {
	// APIURL is the explicit override (MUVLOOM_API_URL). When empty, Run resolves it from
	// the stored connection and then the built-in default.
	APIURL string
	// apiURLSource records how APIURL was resolved for this invocation.
	apiURLSource string
	// storeErr is why the stored connection could not be read when the service was resolved.
	// An unreadable connection hides which service the user signed in to.
	storeErr error
	Store    auth.Store
	Out      io.Writer
	Err      io.Writer
	HTTP     *http.Client
	// Home and CWD override the Skill install roots in tests.
	Home string
	CWD  string
	// Sleep is replaced in tests so polling runs instantly.
	Sleep func(context.Context, time.Duration) error
}

func New(out, errOut io.Writer) *App {
	return &App{
		APIURL: envOr("MUVLOOM_API_URL", ""),
		Store:  auth.Default(),
		Out:    out,
		Err:    errOut,
		HTTP:   &http.Client{Timeout: 60 * time.Second, CheckRedirect: client.NoRedirects},
		Sleep:  sleepContext,
	}
}

// validateAPIURL keeps credentials off plaintext connections: only https, except a
// local development server.
func validateAPIURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fail("USAGE", "MUVLOOM_API_URL %q is not a URL", raw)
	}
	host := parsed.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && local) {
		return fail("USAGE", "MUVLOOM_API_URL must use https (http is only allowed for localhost)")
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return strings.TrimRight(value, "/")
	}
	return fallback
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type command struct {
	usage string
	run   func(ctx context.Context, a *App, args []string) (any, error)
}

func commands() map[string]map[string]command {
	return map[string]map[string]command{
		"version": {"": {"version", cmdVersion}},
		"update":  {"check": {"update check", cmdUpdateCheck}},
		"auth": {
			"status": {"auth status", cmdAuthStatus},
			"login":  {"auth login [--no-wait] [--timeout SECONDS] [--switch-service]", cmdAuthLogin},
			"logout": {"auth logout", cmdAuthLogout},
		},
		"capabilities": {"": {"capabilities", cmdCapabilities}},
		"images": {
			"validate": {"images validate --prompt TEXT [image flags]", cmdImagesValidate},
			"create":   {"images create --prompt TEXT [image flags] [--wait SECONDS] [--download DIR]", cmdImagesCreate},
		},
		"jobs": {
			"get":    {"jobs get JOB_ID", cmdJobsGet},
			"list":   {"jobs list [--limit N] [--cursor JOB_ID] [--idempotency-key KEY]", cmdJobsList},
			"wait":   {"jobs wait JOB_ID [--timeout SECONDS]", cmdJobsWait},
			"cancel": {"jobs cancel JOB_ID", cmdJobsCancel},
		},
		"media": {
			"upload":   {"media upload FILE", cmdMediaUpload},
			"list":     {"media list [--limit N] [--cursor MEDIA_ID]", cmdMediaList},
			"get":      {"media get MEDIA_ID", cmdMediaGet},
			"download": {"media download MEDIA_ID [--output PATH]", cmdMediaDownload},
		},
		"artifacts": {
			"get":      {"artifacts get ARTIFACT_ID", cmdArtifactsGet},
			"download": {"artifacts download ARTIFACT_ID [--output PATH]", cmdArtifactsDownload},
		},
		"skill": {
			"install": {"skill install --host claude-code|codex [--scope user|project]", cmdSkillInstall},
			"status":  {"skill status", cmdSkillStatus},
		},
	}
}

func usage() string {
	lines := []string{}
	table := commands()
	for _, group := range []string{"version", "update", "auth", "capabilities", "images", "jobs", "media", "artifacts", "skill"} {
		for _, sub := range []string{"", "check", "status", "login", "logout", "validate", "create", "get", "list", "wait", "cancel", "upload", "download", "install"} {
			if cmd, ok := table[group][sub]; ok {
				lines = append(lines, "muvloom "+cmd.usage)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// Run executes one command and returns the process exit code.
func (a *App) Run(args []string) int {
	if a.Sleep == nil {
		a.Sleep = sleepContext
	}
	ctx := context.Background()
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		return a.render(nil, fail("USAGE", "%s", usage()))
	}
	group, ok := commands()[args[0]]
	if !ok {
		return a.render(nil, fail("USAGE", "unknown command %q\n%s", args[0], usage()))
	}
	rest := args[1:]
	cmd, ok := group[""]
	if !ok {
		if len(rest) == 0 {
			return a.render(nil, fail("USAGE", "%s needs a subcommand\n%s", args[0], usage()))
		}
		if cmd, ok = group[rest[0]]; !ok {
			return a.render(nil, fail("USAGE", "unknown command %q\n%s", args[0]+" "+rest[0], usage()))
		}
		rest = rest[1:]
	}
	if skipsService[args[0]] {
		if a.APIURL == "" {
			a.APIURL, a.apiURLSource = DefaultAPIURL, sourceDefault
		}
	} else {
		a.resolveAPIURL()
	}
	if err := validateAPIURL(a.APIURL); err != nil {
		return a.render(nil, err)
	}
	data, err := cmd.run(ctx, a, rest)
	return a.render(data, err)
}

// skipsService lists the command groups that never talk to the service. They must not
// touch the credential store, so they cannot trip a keychain prompt just to print a version.
// Every other command resolves the service first, so a new group fails safe.
var skipsService = map[string]bool{"version": true, "update": true, "skill": true}

// resolveAPIURL picks the service for this invocation: an explicit MUVLOOM_API_URL, else the
// service the stored connection was issued by, else the default. A new agent session has no
// environment variable, and must not be taken for signed out because of that.
func (a *App) resolveAPIURL() {
	if a.APIURL != "" {
		a.apiURLSource = sourceEnvironment
		return
	}
	creds, loadErr := a.Store.Load()
	if loadErr == nil && creds.RefreshToken != "" && creds.BaseURL != "" {
		a.APIURL, a.apiURLSource = strings.TrimRight(creds.BaseURL, "/"), sourceConnection
		return
	}
	// The secret may be unreadable while the connection still exists: its service is kept
	// apart from it.
	if service, err := a.Store.LoadService(); err == nil {
		a.APIURL, a.apiURLSource = strings.TrimRight(service, "/"), sourceConnection
		return
	}
	// A login started with `--no-wait` belongs to the service it was started for, even when
	// the next session no longer has the variable that chose it.
	if pending, err := a.Store.LoadPending(); err == nil && pending.BaseURL != "" && time.Now().Before(pending.ExpiresAt) {
		a.APIURL, a.apiURLSource = strings.TrimRight(pending.BaseURL, "/"), sourcePending
		return
	}
	if loadErr != nil && !errors.Is(loadErr, auth.ErrNotFound) {
		a.storeErr = loadErr
	}
	a.APIURL, a.apiURLSource = DefaultAPIURL, sourceDefault
}

// sameService compares service addresses without caring about a trailing slash.
func sameService(a, b string) bool {
	return strings.TrimRight(a, "/") == strings.TrimRight(b, "/")
}

type outputError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

type output struct {
	SchemaVersion int          `json:"schema_version"`
	OK            bool         `json:"ok"`
	Data          any          `json:"data,omitempty"`
	Error         *outputError `json:"error,omitempty"`
}

func (a *App) render(data any, err error) int {
	code := ExitOK
	envelope := output{SchemaVersion: schemaVersion, OK: true, Data: data}
	if err != nil {
		failure := asFailure(err)
		envelope = output{
			SchemaVersion: schemaVersion,
			OK:            false,
			Error:         &outputError{Code: failure.Code, Message: failure.Message, Details: failure.Details},
		}
		code = ExitInternal
		if mapped, ok := exitByCode[failure.Code]; ok {
			code = mapped
		}
	}
	// A caller that never received the envelope must not see success.
	if writeErr := a.write(envelope); writeErr != nil {
		fmt.Fprintf(a.Err, "muvloom: could not write output: %v\n", writeErr)
		return ExitInternal
	}
	return code
}

func asFailure(err error) *Failure {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}
	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		f := &Failure{Code: apiErr.Code, Message: apiErr.Message}
		if len(apiErr.Details) > 0 {
			f.Details = json.RawMessage(apiErr.Details)
		}
		return f
	}
	return &Failure{Code: "INTERNAL_ERROR", Message: err.Error()}
}

func (a *App) write(v any) error {
	encoder := json.NewEncoder(a.Out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(v)
}

// progress writes a human-readable line to stderr; stdout stays machine-readable.
func (a *App) progress(format string, args ...any) {
	fmt.Fprintf(a.Err, format+"\n", args...)
}

func cmdVersion(_ context.Context, _ *App, args []string) (any, error) {
	if len(args) != 0 {
		return nil, fail("USAGE", "usage: muvloom version")
	}
	return map[string]any{"version": Version, "os": runtime.GOOS, "arch": runtime.GOARCH}, nil
}

func (a *App) userAgent() string {
	return userAgentProto + Version + " (" + runtime.GOOS + "/" + runtime.GOARCH + ")"
}

// anonymousClient talks to the OAuth endpoints, which take no bearer token.
func (a *App) anonymousClient() *client.HTTPClient {
	c := client.New(a.APIURL, a.HTTP)
	c.UserAgent = a.userAgent()
	return c
}
