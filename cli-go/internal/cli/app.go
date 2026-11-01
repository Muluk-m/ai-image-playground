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
var Version = "0.1.0"

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

type App struct {
	APIURL string
	Store  auth.Store
	Out    io.Writer
	Err    io.Writer
	HTTP   *http.Client
	// Home and CWD override the Skill install roots in tests.
	Home string
	CWD  string
	// Sleep is replaced in tests so polling runs instantly.
	Sleep func(context.Context, time.Duration) error
}

func New(out, errOut io.Writer) *App {
	return &App{
		APIURL: envOr("MUVLOOM_API_URL", DefaultAPIURL),
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
		"auth": {
			"status": {"auth status", cmdAuthStatus},
			"login":  {"auth login [--no-wait] [--timeout SECONDS]", cmdAuthLogin},
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
	for _, group := range []string{"version", "auth", "capabilities", "images", "jobs", "media", "artifacts", "skill"} {
		for _, sub := range []string{"", "status", "login", "logout", "validate", "create", "get", "list", "wait", "cancel", "upload", "download", "install"} {
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
	if err := validateAPIURL(a.APIURL); err != nil {
		return a.render(nil, err)
	}
	data, err := cmd.run(ctx, a, rest)
	return a.render(data, err)
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
