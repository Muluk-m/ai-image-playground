package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
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
		return auth.Credentials{}, fail("AUTH_REQUIRED", "Stored credentials are unreadable; run `muvloom auth login` (%v)", err)
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
	refreshCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var tokens tokenResponse
	err = a.anonymousClient().PostForm(refreshCtx, "/v1/oauth/token", url.Values{
		"client_id":     {oauthClientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {creds.RefreshToken},
	}, &tokens)
	var oauthErr *client.OAuthError
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
		return "", fail("INTERNAL_ERROR", "Could not store refreshed credentials: %v", err)
	}
	return next.AccessToken, nil
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
	status := map[string]any{
		"cli_version":      Version,
		"api_url":          a.APIURL,
		"api_url_source":   a.apiURLSource,
		"credential_store": a.Store.Backend(),
		"skills":           skills,
	}
	if pending, err := a.Store.LoadPending(); err == nil && time.Now().Before(pending.ExpiresAt) && !completedLogin(a, pending) {
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
	// Starting a login against another service would replace the working connection on
	// approval. Do that only when asked; a login already started for this service (the
	// `--no-wait` then resume flow) was asked for once and is not asked for again.
	resuming := err == nil && sameService(pending.BaseURL, a.APIURL) && time.Now().Before(pending.ExpiresAt)
	if existing, loadErr := a.Store.Load(); loadErr == nil && !*switchService && !resuming &&
		existing.RefreshToken != "" && existing.BaseURL != "" && !sameService(existing.BaseURL, a.APIURL) {
		return nil, a.serviceMismatch(existing.BaseURL)
	}
	// Without an explicit service, an unreadable connection must not be answered with a guess:
	// the default service may not be the one this user can sign in to.
	if a.storeErr != nil && !*switchService && !resuming {
		// The store's own error can carry local paths; the answer stays generic.
		return nil, fail("INTERNAL_ERROR", "The stored connection could not be read, so the service it belongs to is unknown. Fix the credential store, or set MUVLOOM_API_URL to the service to sign in to")
	}
	// A host may replay the whole command after blocking cleanup. Never redeem a
	// consumed code when its credentials were already saved, even after code expiry.
	if err == nil && completedLogin(a, pending) {
		return cmdAuthStatus(ctx, a, nil)
	}
	if err != nil || time.Now().After(pending.ExpiresAt) || !sameService(pending.BaseURL, a.APIURL) {
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
		if err := a.Store.SavePending(pending); err != nil {
			return nil, fail("INTERNAL_ERROR", "Could not store the pending login: %v", err)
		}
	}
	prompt := map[string]any{
		"state":                     "pending",
		"user_code":                 pending.UserCode,
		"verification_uri_complete": pending.VerificationURIComplete,
		"expires_at":                pending.ExpiresAt,
	}
	a.progress("Open %s and confirm code %s", pending.VerificationURIComplete, pending.UserCode)
	if *noWait {
		return prompt, nil
	}
	deadline := time.Now().Add(seconds(*timeout, 0, 3600))
	interval := seconds(pending.IntervalSeconds, 1, 60)
	for {
		var tokens tokenResponse
		err := a.anonymousClient().PostForm(ctx, "/v1/oauth/token", url.Values{
			"client_id":   {oauthClientID},
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {pending.DeviceCode},
		}, &tokens)
		if err == nil {
			creds := a.credentialsFrom(tokens)
			creds.LoginDeviceCodeHash = deviceCodeHash(pending.DeviceCode)
			if err := a.Store.Save(creds); err != nil {
				return nil, fail("INTERNAL_ERROR", "Could not store credentials: %v", err)
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
		return nil, fail("INTERNAL_ERROR", "Could not remove stored credentials: %v", err)
	}
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
