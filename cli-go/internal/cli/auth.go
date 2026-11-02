package cli

import (
	"context"
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
	if creds.BaseURL != "" && creds.BaseURL != a.APIURL {
		return auth.Credentials{}, fail("AUTH_REQUIRED", "Signed in to %s, not %s; run `muvloom auth login`", creds.BaseURL, a.APIURL)
	}
	return creds, nil
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
	unlock, err := a.Store.Lock(45 * time.Second)
	if err != nil {
		return "", err
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
	if err != nil {
		return "", err
	}
	next := a.credentialsFrom(tokens)
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
		"credential_store": a.Store.Backend(),
		"skills":           skills,
	}
	if pending, err := a.Store.LoadPending(); err == nil && time.Now().Before(pending.ExpiresAt) {
		status["pending_login"] = map[string]any{
			"user_code":                 pending.UserCode,
			"verification_uri_complete": pending.VerificationURIComplete,
			"expires_at":                pending.ExpiresAt,
		}
	}
	c, err := a.apiClient()
	if err != nil {
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
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	pending, err := a.Store.LoadPending()
	if err != nil || time.Now().After(pending.ExpiresAt) || pending.BaseURL != a.APIURL {
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
			_ = a.Store.ClearPending()
			if err := a.Store.Save(a.credentialsFrom(tokens)); err != nil {
				return nil, fail("INTERNAL_ERROR", "Could not store credentials: %v", err)
			}
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
			case "expired_token", "invalid_grant":
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
