// Package cli implements the muvloom command line. stdout carries the result as text, or
// with `--json` exactly one JSON envelope per invocation; progress, and failures in text
// mode, go to stderr. Access and refresh
// tokens, the secret device_code and signed upload URLs never reach either stream. The
// user_code and its verification link are shown on purpose (RFC 8628 §3.3): approving
// them only links a session to the account of whoever approves it.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

// Version is overridden at release time with -ldflags "-X .../cli.Version=x.y.z".
var Version = "0.2.1"

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
	"INVALID_REQUEST":             ExitInvalid,
	"SERVICE_MISMATCH":            ExitRejected,
	"USAGE":                       ExitInvalid,
	"UNAUTHENTICATED":             ExitAuth,
	"AUTH_REQUIRED":               ExitAuth,
	"AUTH_PENDING":                ExitAuth,
	"AUTH_DENIED":                 ExitAuth,
	"AUTH_EXPIRED":                ExitAuth,
	"FORBIDDEN":                   ExitRejected,
	"PLAN_REQUIRED":               ExitRejected,
	"NOT_FOUND":                   ExitRejected,
	"CONFLICT":                    ExitRejected,
	"IDEMPOTENCY_CONFLICT":        ExitRejected,
	"JOB_NOT_CANCELLABLE":         ExitRejected,
	"MODEL_UNAVAILABLE":           ExitRejected,
	"CAPABILITY_UNAVAILABLE":      ExitRejected,
	"MEDIA_NOT_READY":             ExitRejected,
	"REQUEST_TOO_LARGE":           ExitRejected,
	"FILE_EXISTS":                 ExitRejected,
	"JOB_FAILED":                  ExitRejected,
	"JOB_CANCELED":                ExitRejected,
	"INSUFFICIENT_CREDITS":        ExitCredits,
	"MAX_CREDITS_EXCEEDED":        ExitCredits,
	"NETWORK_ERROR":               ExitTemporary,
	"RATE_LIMITED":                ExitTemporary,
	"TEMPORARILY_UNAVAILABLE":     ExitTemporary,
	"INTERNAL_ERROR":              ExitTemporary,
	"CREDENTIAL_STORE_UNWRITABLE": ExitRejected,
	"UNSUPPORTED_VERSION":         ExitVersion,
	"UPGRADE_REQUIRED":            ExitVersion,
}

// Failure is a command error with a stable code, rendered as the error envelope or text.
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
	// json selects the machine-readable envelope (`--json`) instead of text for this run.
	json bool
	// command is the command being run, for help hints and its text layout.
	command string
	Out     io.Writer
	Err     io.Writer
	HTTP    *http.Client
	// RefreshLockWait bounds the wait for another process that is refreshing the token.
	// Zero means the default.
	RefreshLockWait time.Duration
	// Home and CWD override the Skill install roots in tests.
	Home string
	CWD  string
	// Sleep is replaced in tests so polling runs instantly.
	Sleep func(context.Context, time.Duration) error
	// OpenBrowser and Listen replace the system browser and the loopback listener in tests.
	OpenBrowser func(url string) error
	Listen      func(network, addr string) (net.Listener, error)
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
	name    string // "images create"
	args    string // positional arguments and the most used flags, for the usage line
	summary string
	run     func(ctx context.Context, a *App, args []string) (any, error)
}

// commandList is every command, in the order help shows them.
var commandList = []struct {
	section  string
	commands []command
}{
	{"ACCOUNT", []command{
		{"auth login", "[--no-wait] [--timeout SECONDS] [--switch-service]", "Connect this machine to your Muvloom account in the browser", cmdAuthLogin},
		{"auth status", "", "Show the connection, account and credits", cmdAuthStatus},
		{"auth logout", "", "Revoke this connection and forget it", cmdAuthLogout},
	}},
	{"GENERATE", []command{
		{"capabilities", "", "Models, output formats, sizes, limits and prices for your account", cmdCapabilities},
		{"images create", "--prompt TEXT [flags]", "Generate an image, an animated GIF or an SVG", cmdImagesCreate},
		{"images validate", "--prompt TEXT [flags]", "Check a request and quote its cost without creating anything", cmdImagesValidate},
	}},
	{"JOBS AND FILES", []command{
		{"jobs list", "[--limit N] [--cursor JOB_ID] [--idempotency-key KEY]", "Recent jobs, newest first", cmdJobsList},
		{"jobs get", "JOB_ID", "Show one job", cmdJobsGet},
		{"jobs wait", "JOB_ID [--timeout SECONDS]", "Wait for a job to finish", cmdJobsWait},
		{"jobs cancel", "JOB_ID", "Cancel a queued or running job (refunded)", cmdJobsCancel},
		{"artifacts get", "ARTIFACT_ID", "Show a generated image", cmdArtifactsGet},
		{"artifacts download", "ARTIFACT_ID [--output PATH]", "Save a generated image", cmdArtifactsDownload},
		{"media upload", "FILE", "Upload a reference image", cmdMediaUpload},
		{"media list", "[--limit N] [--cursor MEDIA_ID]", "Uploaded reference images", cmdMediaList},
		{"media get", "MEDIA_ID", "Show an uploaded reference image", cmdMediaGet},
		{"media download", "MEDIA_ID [--output PATH]", "Save an uploaded reference image", cmdMediaDownload},
	}},
	{"SETUP", []command{
		{"skill install", "--host claude-code|codex [--scope user|project]", "Install the bundled agent Skill", cmdSkillInstall},
		{"skill status", "", "Where the agent Skill is installed and its version", cmdSkillStatus},
		{"update check", "", "Check for a newer CLI release (cached for the day)", cmdUpdateCheck},
		{"version", "", "Print the CLI version", cmdVersion},
	}},
}

// lookup finds the command named by the first one or two arguments.
func lookup(args []string) (command, []string, bool) {
	for _, section := range commandList {
		for _, cmd := range section.commands {
			words := strings.Fields(cmd.name)
			if len(args) >= len(words) && strings.Join(args[:len(words)], " ") == cmd.name {
				return cmd, args[len(words):], true
			}
		}
	}
	return command{}, nil, false
}

// group lists the subcommands of a command group such as "jobs"; nil when there is none.
func group(name string) []command {
	var found []command
	for _, section := range commandList {
		for _, cmd := range section.commands {
			if strings.HasPrefix(cmd.name, name+" ") {
				found = append(found, cmd)
			}
		}
	}
	return found
}

// jsonFlag recognizes --json, -json and their =true / =false forms.
func jsonFlag(arg string) (on bool, ok bool) {
	name, value, hasValue := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "-"), "-"), "=")
	if !strings.HasPrefix(arg, "-") || name != "json" {
		return false, false
	}
	if !hasValue {
		return true, true
	}
	on, err := strconv.ParseBool(value)
	return on, err == nil
}

func isHelpFlag(arg string) bool {
	return arg == "-h" || arg == "--help" || arg == "-help"
}

// Run executes one command and returns the process exit code.
func (a *App) Run(args []string) int {
	if a.Sleep == nil {
		a.Sleep = sleepContext
	}
	ctx := context.Background()
	// --json is global: it may stand anywhere before a `--`.
	a.json, a.command = false, ""
	// Global flags may stand before and between the command words; after the command, only
	// where its flags allow (see commandArgs), so a flag value such as `--prompt --json` stays a value.
	var words []string
	for len(args) > 0 && len(words) < 2 {
		if on, ok := jsonFlag(args[0]); ok {
			a.json = on
		} else if strings.HasPrefix(args[0], "-") && len(words) > 0 {
			break
		} else {
			words = append(words, args[0])
		}
		args = args[1:]
	}
	args = append(words, args...)
	// `-v`, `-V` and `--version` are what people (and agents) type first. Only when they stand alone.
	if len(args) == 1 && (args[0] == "-v" || args[0] == "-V" || args[0] == "--version") {
		args = []string{"version"}
	}
	if len(args) == 0 || isHelpFlag(args[0]) {
		return a.help(mainHelp())
	}
	if args[0] == "help" {
		if len(args) == 1 {
			return a.help(mainHelp())
		}
		args = append(args[1:], "--help")
	}
	cmd, rest, ok := lookup(args)
	if !ok {
		if subs := group(args[0]); subs != nil {
			if len(args) > 1 && isHelpFlag(args[1]) {
				return a.help(groupHelp(args[0], subs))
			}
			if len(args) == 1 {
				return a.usageError(args[0], "%s needs a subcommand: %s", args[0], subcommandNames(subs))
			}
			return a.usageError(args[0], "unknown command %q; %s has: %s", args[0]+" "+args[1], args[0], subcommandNames(subs))
		}
		return a.usageError("", "unknown command %q", args[0])
	}
	a.command = cmd.name
	// Parsing stops at the help flag, before the command reads the store or the network, so
	// this also yields the command's flags without side effects.
	_, err := cmd.run(ctx, a, []string{"--help"})
	var request *helpRequest
	if !errors.As(err, &request) {
		return a.render(nil, err)
	}
	rest, help := a.commandArgs(rest, request.flags)
	if help {
		return a.help(commandHelp(cmd, request.flags))
	}
	if skipsService[strings.Fields(cmd.name)[0]] {
		if a.APIURL == "" {
			a.APIURL, a.apiURLSource = DefaultAPIURL, sourceDefault
		}
	} else {
		a.resolveAPIURL(cmd.name == "auth login")
	}
	if err := validateAPIURL(a.APIURL); err != nil {
		return a.render(nil, err)
	}
	data, err := cmd.run(ctx, a, rest)
	return a.render(data, err)
}

// commandArgs removes the global flags from a command's arguments and reports a help flag.
// A token is a flag only where the command's own parsing would read one: not as the value of
// a flag that takes one, and not after `--`.
func (a *App) commandArgs(args []string, fs *flag.FlagSet) ([]string, bool) {
	var kept []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return append(kept, args[i:]...), false
		}
		if on, ok := jsonFlag(arg); ok {
			a.json = on
			continue
		}
		if isHelpFlag(arg) {
			return nil, true
		}
		kept = append(kept, arg)
		if !strings.HasPrefix(arg, "-") || strings.Contains(arg, "=") {
			continue
		}
		f := fs.Lookup(strings.TrimLeft(arg, "-"))
		if f == nil || i+1 == len(args) {
			continue
		}
		if boolean, ok := f.Value.(interface{ IsBoolFlag() bool }); !ok || !boolean.IsBoolFlag() {
			i++
			kept = append(kept, args[i])
		}
	}
	return kept, false
}

// usageError reports a command line that names no command; help points at the right page.
func (a *App) usageError(helpFor, format string, args ...any) int {
	a.command = helpFor
	return a.render(nil, fail("USAGE", format, args...))
}

// skipsService lists the command groups that never talk to the service. They must not
// touch the credential store, so they cannot trip a keychain prompt just to print a version.
// Every other command resolves the service first, so a new group fails safe.
var skipsService = map[string]bool{"version": true, "update": true, "skill": true}

// resolveAPIURL picks the service for this invocation: an explicit MUVLOOM_API_URL, else the
// service the stored connection was issued by, else the default. A new agent session has no
// environment variable, and must not be taken for signed out because of that.
//
// resumingLogin is true for `auth login`: a login started earlier (possibly a deliberate
// switch to another service) is finished against the service it was started for. Other commands
// keep using the working connection while the switch is pending.
func (a *App) resolveAPIURL(resumingLogin bool) {
	if a.APIURL != "" {
		a.apiURLSource = sourceEnvironment
		return
	}
	if resumingLogin {
		if pending, err := a.Store.LoadPending(); err == nil && pending.BaseURL != "" && time.Now().Before(pending.ExpiresAt) {
			a.APIURL, a.apiURLSource = strings.TrimRight(pending.BaseURL, "/"), sourcePending
			return
		}
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
	var failure *Failure
	if err != nil {
		failure = asFailure(err)
		code = ExitInternal
		if mapped, ok := exitByCode[failure.Code]; ok {
			code = mapped
		}
	}
	var writeErr error
	switch {
	case a.json && failure != nil:
		writeErr = a.write(output{
			SchemaVersion: schemaVersion,
			Error:         &outputError{Code: failure.Code, Message: failure.Message, Details: failure.Details},
		})
	case a.json:
		writeErr = a.write(output{SchemaVersion: schemaVersion, OK: true, Data: data})
	case failure != nil:
		_, writeErr = io.WriteString(a.Err, a.failureText(failure))
	default:
		writeErr = a.writeText(data)
	}
	// A caller that never received the result must not see success.
	if writeErr != nil {
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

// progress writes a line to stderr, so stdout carries only the result.
func (a *App) progress(format string, args ...any) {
	fmt.Fprintf(a.Err, format+"\n", args...)
}

func cmdVersion(_ context.Context, _ *App, args []string) (any, error) {
	if _, err := parse(newFlags("version"), args, 0); err != nil {
		return nil, err
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
