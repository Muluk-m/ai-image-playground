package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

type tokenResponse struct {
	AccessToken           string `json:"access_token"`
	RefreshToken          string `json:"refresh_token"`
	ExpiresIn             int    `json:"expires_in"`
	RefreshTokenExpiresIn int    `json:"refresh_token_expires_in"`
}

// seconds converts a server- or user-supplied count to a Duration, clamped so a hostile
// or corrupt value cannot overflow into a negative interval.
func seconds(n, lo, hi int) time.Duration {
	return time.Duration(min(max(n, lo), hi)) * time.Second
}

func (a *App) credentialsFrom(tokens tokenResponse) auth.Credentials {
	now := time.Now()
	return auth.Credentials{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		AccessExpiresAt:  now.Add(seconds(tokens.ExpiresIn, 0, 24*3600)),
		RefreshExpiresAt: now.Add(seconds(tokens.RefreshTokenExpiresIn, 0, 400*24*3600)),
		BaseURL:          a.APIURL,
	}
}

// loadCredentials returns credentials for the current API URL or AUTH_REQUIRED.
func (a *App) loadCredentials() (auth.Credentials, error) {
	creds, err := a.Store.Load()
	if errors.Is(err, auth.ErrNotFound) || (err == nil && creds.RefreshToken == "") {
		return auth.Credentials{}, fail("AUTH_REQUIRED", "Not signed in; run `muvloom auth login`")
	}
	if err != nil {
		return auth.Credentials{}, fail("AUTH_REQUIRED", "Stored credentials are unreadable (%s); run `muvloom auth login`", auth.Reason(err))
	}
	if creds.BaseURL != "" && !sameService(creds.BaseURL, a.APIURL) {
		return auth.Credentials{}, a.serviceMismatch(creds.BaseURL)
	}
	return creds, nil
}

// serviceMismatch is an explicit MUVLOOM_API_URL that disagrees with the service the stored
// connection was issued by. The connection is kept: the caller decides which service is meant.
func (a *App) serviceMismatch(connectionURL string) *Failure {
	return &Failure{
		Code:    "SERVICE_MISMATCH",
		Message: "MUVLOOM_API_URL points at " + a.APIURL + ", but this machine is signed in to " + connectionURL + ". Unset MUVLOOM_API_URL to use the connection, or run `muvloom auth login --switch-service` to sign in to " + a.APIURL + " instead",
		Details: map[string]string{"api_url": a.APIURL, "connection_api_url": connectionURL},
	}
}

// apiClient returns a client that refreshes the access token once on a 401.
func (a *App) apiClient() (*client.HTTPClient, error) {
	creds, err := a.loadCredentials()
	if err != nil {
		return nil, err
	}
	c := a.anonymousClient()
	c.AccessToken = creds.AccessToken
	c.Refresh = a.refresh
	return c, nil
}

// refresh rotates the token under a cross-process lock. If another process already
// rotated it, the stored access token differs from the rejected one and is reused, so
// the old refresh token is never presented twice (a replay revokes the connection).
func (a *App) refresh(ctx context.Context, rejected string) (string, error) {
	wait := a.RefreshLockWait
	if wait <= 0 {
		wait = 45 * time.Second
	}
	unlock, err := a.Store.Lock(wait)
	if errors.Is(err, auth.ErrLockTimeout) {
		return "", fail("TEMPORARILY_UNAVAILABLE", "Another muvloom process is refreshing the connection; retry shortly")
	}
	if err != nil {
		// A storage fault will not clear by retrying, and the raw error carries local paths.
		return "", fail("INTERNAL_ERROR", "Could not lock the credential store; check that the muvloom config directory is writable")
	}
	defer unlock()
	creds, err := a.loadCredentials()
	if err != nil {
		return "", err
	}
	if creds.AccessToken != rejected && time.Now().Before(creds.AccessExpiresAt) {
		return creds.AccessToken, nil
	}
	// The request identity is stored before the request leaves: if the response is lost, the
	// next refresh presents the same token with the same identity and gets the same tokens.
	// A refresh that could not be repeated is not sent.
	if creds.RefreshRequestID == "" {
		if err := a.persistRefreshRequestID(&creds); err != nil {
			return "", err
		}
	}
	refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// A recovered result whose access token has already expired comes back with no lifetime
	// left: it is stored, then rotated once more under a new identity.
	for attempt := 0; ; attempt++ {
		tokens, err := a.postRefresh(refreshCtx, creds)
		var oauthErr *client.OAuthError
		if errors.As(err, &oauthErr) && oauthErr.Code == "refresh_request_completed" && attempt == 0 {
			// This identity already rotated the connection and the stored token is the result:
			// it is still valid, it just needs an identity of its own.
			if err := a.persistRefreshRequestID(&creds); err != nil {
				return "", err
			}
			continue
		}
		if errors.As(err, &oauthErr) && oauthErr.Code == "invalid_grant" {
			_ = a.Store.Clear()
			return "", fail("AUTH_REQUIRED", "The CLI connection expired or was revoked; run `muvloom auth login`")
		}
		if errors.As(err, &oauthErr) {
			// The connection is intact: only the service is busy or misbehaving.
			if oauthErr.Status == http.StatusTooManyRequests {
				return "", fail("RATE_LIMITED", "Too many refresh attempts; wait a minute and retry")
			}
			return "", fail("TEMPORARILY_UNAVAILABLE", "The service could not refresh the connection (%s); retry shortly", oauthErr.Code)
		}
		if err != nil {
			return "", err
		}
		next := a.credentialsFrom(tokens)
		next.LoginDeviceCodeHash = creds.LoginDeviceCodeHash
		if err := a.Store.Save(next); err != nil {
			// The stored request identity stays: the next refresh repeats this one.
			return "", fail("INTERNAL_ERROR", "Could not store refreshed credentials (%s)", auth.Reason(err))
		}
		if tokens.ExpiresIn > 0 || attempt >= 2 {
			return next.AccessToken, nil
		}
		creds = next
		if err := a.persistRefreshRequestID(&creds); err != nil {
			return "", err
		}
	}
}

func (a *App) persistRefreshRequestID(creds *auth.Credentials) error {
	id, err := newRequestID()
	if err != nil {
		return fail("INTERNAL_ERROR", "Could not create a refresh request identity")
	}
	next := *creds
	next.RefreshRequestID = id
	if err := a.Store.Save(next); err != nil {
		return fail("CREDENTIAL_STORE_UNWRITABLE", "Could not update stored credentials before refreshing (%s); check that the muvloom config directory is writable", auth.Reason(err))
	}
	*creds = next
	return nil
}

func (a *App) postRefresh(ctx context.Context, creds auth.Credentials) (tokenResponse, error) {
	var tokens tokenResponse
	err := a.anonymousClient().PostForm(ctx, "/v1/oauth/token", url.Values{
		"client_id":     {oauthClientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {creds.RefreshToken},
		"request_id":    {creds.RefreshRequestID},
	}, &tokens)
	return tokens, err
}

// newRequestID is a random UUID v4, the form the service accepts for request identities.
func newRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

type account struct {
	Account struct {
		ID       string  `json:"id"`
		Username string  `json:"username"`
		Nickname *string `json:"nickname"`
	} `json:"account"`
	Credits       *float64 `json:"credits"`
	Member        *bool    `json:"member"`
	Scopes        []string `json:"scopes"`
	MinCLIVersion string   `json:"min_cli_version"`
}

func completedLogin(a *App, pending auth.PendingLogin) bool {
	creds, err := a.Store.Load()
	if err != nil || !sameService(creds.BaseURL, a.APIURL) || !sameService(pending.BaseURL, a.APIURL) || creds.RefreshToken == "" {
		return false
	}
	return pending.DeviceCode != "" && creds.LoginDeviceCodeHash == deviceCodeHash(pending.DeviceCode)
}

// recoverable is a login the service already approved and redeemed, whose credentials could not
// be stored: it can still be finished without a new approval.
func recoverable(pending auth.PendingLogin) bool {
	return pending.Redeemed && pending.RequestID != "" && time.Now().Before(pending.ExpiresAt.Add(time.Hour))
}

func deviceCodeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// cmdAuthStatus is the cheap first call an agent makes: it never fails on a missing
// login or an unreachable server, it reports the state instead.
func cmdAuthStatus(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("auth status")
	fs.Bool("json", true, "accepted for compatibility; output is always JSON")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	skills, _ := skill.Installed(a.Home, a.CWD)
	store := a.Store.Describe()
	status := map[string]any{
		"cli_version":      Version,
		"api_url":          a.APIURL,
		"api_url_source":   a.apiURLSource,
		"credential_store": store.Backend,
		"skills":           skills,
	}
	if store.KeychainIssue != "" {
		status["credential_store_issue"] = store.KeychainIssue
	}
	if leftovers := a.Store.Leftovers(); len(leftovers) > 0 {
		status["leftover_temp_files"] = len(leftovers)
	}
	if pending, err := a.Store.LoadPending(); err == nil && (time.Now().Before(pending.ExpiresAt) || recoverable(pending)) && !completedLogin(a, pending) {
		status["pending_login"] = map[string]any{
			"user_code":                 pending.UserCode,
			"verification_uri_complete": pending.VerificationURIComplete,
			"expires_at":                pending.ExpiresAt,
		}
	}
	c, err := a.apiClient()
	if err != nil {
		if failure := asFailure(err); failure.Code == "SERVICE_MISMATCH" {
			status["state"] = "service_mismatch"
			details, _ := failure.Details.(map[string]string)
			status["connection_api_url"] = details["connection_api_url"]
			return status, nil
		}
		status["state"] = "unauthenticated"
		return status, nil
	}
	var me account
	if err := c.Do(ctx, http.MethodGet, "/v1/me", nil, &me); err != nil {
		failure := asFailure(err)
		switch exitByCode[failure.Code] {
		case ExitAuth:
			status["state"] = "unauthenticated"
		case ExitVersion:
			status["state"] = "outdated"
		default:
			status["state"] = "unreachable"
			status["error"] = map[string]string{"code": failure.Code, "message": failure.Message}
		}
		return status, nil
	}
	status["account"] = me.Account
	status["credits"] = me.Credits
	status["member"] = me.Member
	status["scopes"] = me.Scopes
	status["min_cli_version"] = me.MinCLIVersion
	update := versionLess(Version, me.MinCLIVersion)
	status["update_required"] = update
	if update {
		status["state"] = "outdated"
	} else {
		status["state"] = "ready"
	}
	return status, nil
}

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// cmdAuthLogin runs the RFC 8628 device flow. The device code stays on disk between
// `--no-wait` and a later resume; only the user code and URL are ever printed.
func cmdAuthLogin(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("auth login")
	noWait := fs.Bool("no-wait", false, "print the approval link and return without waiting")
	timeout := fs.Int("timeout", 600, "seconds to wait for approval")
	switchService := fs.Bool("switch-service", false, "sign in to MUVLOOM_API_URL even though this machine is signed in to another service")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	pending, err := a.Store.LoadPending()
	// A code the server already redeemed, whose tokens never reached the credential store, is
	// redeemed again with the same request identity, even after the code expired: the service
	// answers with the same tokens for an hour past expiry.
	redeemed := err == nil && sameService(pending.BaseURL, a.APIURL) && recoverable(pending)
	// Starting a login against another service would replace the working connection on
	// approval. Do that only when asked; a login already started for this service (the
	// `--no-wait` then resume flow) was asked for once and is not asked for again.
	fresh := err == nil && sameService(pending.BaseURL, a.APIURL) && time.Now().Before(pending.ExpiresAt)
	resuming := fresh || redeemed
	// Past the code's own lifetime, a redeemed login is not exempt from these checks: it was
	// asked for once, but long enough ago that another connection may be in use now.
	if existing, loadErr := a.Store.Load(); loadErr == nil && !*switchService && !fresh &&
		existing.RefreshToken != "" && existing.BaseURL != "" && !sameService(existing.BaseURL, a.APIURL) {
		return nil, a.serviceMismatch(existing.BaseURL)
	}
	// Without an explicit service, an unreadable connection must not be answered with a guess:
	// the default service may not be the one this user can sign in to.
	if a.storeErr != nil && !*switchService && !fresh {
		// The store's own error can carry local paths; the answer stays generic.
		return nil, fail("INTERNAL_ERROR", "The stored connection could not be read, so the service it belongs to is unknown. Fix the credential store, or set MUVLOOM_API_URL to the service to sign in to")
	}
	// A host may replay the whole command after blocking cleanup. Never redeem a
	// consumed code when its credentials were already saved, even after code expiry.
	if err == nil && completedLogin(a, pending) {
		return cmdAuthStatus(ctx, a, nil)
	}
	// The device code is redeemed once. If what comes back cannot be stored, the login is lost,
	// so find that out before the user is asked to approve anything.
	if err := a.Store.Preflight(); err != nil {
		if errors.Is(err, auth.ErrLockTimeout) {
			return nil, fail("TEMPORARILY_UNAVAILABLE", "Another muvloom process is writing credentials; retry shortly")
		}
		return nil, fail("CREDENTIAL_STORE_UNWRITABLE", "Credentials cannot be stored (%s); make the muvloom config directory writable, or set MUVLOOM_CONFIG_DIR to a writable directory, then run `muvloom auth login` again", auth.Reason(err))
	}
	if !resuming {
		var device deviceAuthorization
		if err := a.anonymousClient().PostForm(ctx, "/v1/oauth/device_authorization",
			url.Values{"client_id": {oauthClientID}}, &device); err != nil {
			return nil, oauthFailure(err)
		}
		pending = auth.PendingLogin{
			DeviceCode:              device.DeviceCode,
			UserCode:                device.UserCode,
			VerificationURIComplete: device.VerificationURIComplete,
			ExpiresAt:               time.Now().Add(seconds(device.ExpiresIn, 0, 3600)),
			IntervalSeconds:         min(max(device.Interval, 1), 60),
			BaseURL:                 a.APIURL,
		}
	}
	// A login started by an older version has no identity yet; it gets one before the code
	// is redeemed, and keeps it for every later attempt.
	if pending.RequestID == "" || !resuming {
		if pending.RequestID == "" {
			id, err := newRequestID()
			if err != nil {
				return nil, fail("INTERNAL_ERROR", "Could not create a login request identity")
			}
			pending.RequestID = id
		}
		if err := a.Store.SavePending(pending); err != nil {
			return nil, fail("CREDENTIAL_STORE_UNWRITABLE", "Could not store the pending login (%s); check that the muvloom config directory is writable", auth.Reason(err))
		}
	}
	prompt := map[string]any{
		"state":                     "pending",
		"user_code":                 pending.UserCode,
		"verification_uri_complete": pending.VerificationURIComplete,
		"expires_at":                pending.ExpiresAt,
	}
	if !pending.Redeemed {
		a.progress("Open %s and confirm code %s", pending.VerificationURIComplete, pending.UserCode)
		if *noWait {
			return prompt, nil
		}
	}
	deadline := time.Now().Add(seconds(*timeout, 0, 3600))
	interval := seconds(pending.IntervalSeconds, 1, 60)
	for {
		var tokens tokenResponse
		err := a.anonymousClient().PostForm(ctx, "/v1/oauth/token", url.Values{
			"client_id":   {oauthClientID},
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {pending.DeviceCode},
			"request_id":  {pending.RequestID},
		}, &tokens)
		if err == nil {
			creds := a.credentialsFrom(tokens)
			creds.LoginDeviceCodeHash = deviceCodeHash(pending.DeviceCode)
			if err := a.Store.Save(creds); err != nil {
				// The server issued the tokens; the pending login keeps what it takes to get the
				// same ones again, so running the command again finishes without a new approval.
				pending.Redeemed = true
				_ = a.Store.SavePending(pending)
				return nil, fail("CREDENTIAL_STORE_UNWRITABLE", "Signed in, but the credentials could not be stored (%s); make the muvloom config directory writable, then run `muvloom auth login` again: it finishes without a new approval when the service supports it, otherwise it asks for one", auth.Reason(err))
			}
			_ = a.Store.ClearPending()
			a.progress("Signed in.")
			return cmdAuthStatus(ctx, a, nil)
		}
		var oauthErr *client.OAuthError
		if !errors.As(err, &oauthErr) {
			if exitByCode[asFailure(err).Code] != ExitTemporary {
				return nil, err
			}
		} else {
			switch oauthErr.Code {
			case "authorization_pending":
			case "slow_down":
				interval = min(interval+5*time.Second, time.Minute)
			case "access_denied":
				_ = a.Store.ClearPending()
				return nil, fail("AUTH_DENIED", "The connection was denied in the browser")
			case "invalid_grant":
				_ = a.Store.ClearPending()
				return nil, fail("AUTH_REQUIRED", "The login code is invalid or already used; check `muvloom auth status` before starting a new login")
			case "expired_token":
				_ = a.Store.ClearPending()
				return nil, fail("AUTH_EXPIRED", "The login code expired; run `muvloom auth login` again")
			default:
				return nil, oauthFailure(err)
			}
		}
		if time.Now().Add(interval).After(deadline) {
			return nil, &Failure{
				Code:    "AUTH_PENDING",
				Message: "Still waiting for browser approval; run `muvloom auth login` again to resume",
				Details: prompt,
			}
		}
		if err := a.Sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
}

func oauthFailure(err error) error {
	var oauthErr *client.OAuthError
	if errors.As(err, &oauthErr) {
		if oauthErr.Status == http.StatusNotFound {
			return fail("CAPABILITY_UNAVAILABLE", "The CLI API is not enabled on %s", "this server")
		}
		if oauthErr.Status == http.StatusTooManyRequests {
			return fail("RATE_LIMITED", "Too many login attempts; wait a minute and retry")
		}
		return fail("INTERNAL_ERROR", "Login failed: %s", oauthErr.Code)
	}
	return err
}

func cmdAuthLogout(ctx context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("auth logout"), args, 0); err != nil {
		return nil, err
	}
	creds, err := a.Store.Load()
	revoked := false
	if err == nil && creds.RefreshToken != "" && validateAPIURL(creds.BaseURL) == nil {
		// Revoke on the server that issued the token, never on whatever MUVLOOM_API_URL says
		// now; revoking any token of the connection revokes all of it; failure is not fatal.
		issuer := client.New(creds.BaseURL, a.HTTP)
		issuer.UserAgent = a.userAgent()
		revoked = issuer.PostForm(ctx, "/v1/oauth/revoke", url.Values{
			"client_id": {oauthClientID},
			"token":     {creds.RefreshToken},
		}, nil) == nil
	}
	if err := a.Store.Clear(); err != nil {
		return nil, fail("INTERNAL_ERROR", "Could not remove stored credentials (%s)", auth.Reason(err))
	}
	// An explicit sign-out is the one place that may delete: remove what earlier versions left.
	a.Store.CleanupLeftovers()
	return map[string]any{"signed_out": true, "server_revoked": revoked}, nil
}

// versionLess compares dotted numeric versions; unknown formats never force an upgrade.
func versionLess(current, minimum string) bool {
	if minimum == "" {
		return false
	}
	cur := strings.Split(strings.TrimPrefix(current, "v"), ".")
	req := strings.Split(strings.TrimPrefix(minimum, "v"), ".")
	for i := 0; i < max(len(cur), len(req)); i++ {
		var c, r int
		var err error
		if i < len(cur) {
			if c, err = strconv.Atoi(cur[i]); err != nil {
				return false
			}
		}
		if i < len(req) {
			if r, err = strconv.Atoi(req[i]); err != nil {
				return false
			}
		}
		if c != r {
			return c < r
		}
	}
	return false
}

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse accepts flags before or after positional arguments and checks their count.
func parse(fs *flag.FlagSet, args []string, positional int) ([]string, error) {
	var rest []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return nil, fail("USAGE", "%s: %v", fs.Name(), err)
		}
		args = fs.Args()
		if len(args) > 0 {
			rest = append(rest, args[0])
			args = args[1:]
		}
	}
	if len(rest) != positional {
		return nil, fail("USAGE", "%s expects %d argument(s), got %d", fs.Name(), positional, len(rest))
	}
	return rest, nil
}
