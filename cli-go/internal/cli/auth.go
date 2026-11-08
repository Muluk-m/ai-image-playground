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
	"net"
	"net/http"
	"net/url"
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

// recoverable is an expired login that carries a request identity, still inside the hour the
// service repeats a redemption for. Whether the code was redeemed is not trusted to the local
// record, which may not have been written after the failure: the service decides.
func recoverable(pending auth.PendingLogin) bool {
	return pending.RequestID != "" && !time.Now().Before(pending.ExpiresAt) && time.Now().Before(pending.ExpiresAt.Add(time.Hour))
}

func deviceCodeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// cmdAuthStatus is the first call an agent makes: it never fails on a missing
// login or an unreachable server, it reports the state instead.
func cmdAuthStatus(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("auth status")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	// Copies this CLI installed follow it: an older one that nobody edited is replaced with
	// the bundled Skill, effective from the host's next session. Only a copy that cannot be
	// verified, was edited, or could not be replaced is reported, naming its path, since any
	// host may be the one calling.
	skills, failed, refreshErr := skill.RefreshOutdated(a.Home, a.CWD)
	if refreshErr != nil {
		a.progress("Could not check the installed muvloom Skills: %v", refreshErr)
	}
	for _, installed := range skills {
		switch {
		case installed.Unverifiable:
			a.progress("The muvloom Skill at %s is incomplete or has unexpected files. To reinstall it: muvloom skill install --host %s --scope %s",
				installed.Path, installed.Host, installed.Scope)
		case !installed.Intact:
			a.progress("The muvloom Skill at %s was edited or is incomplete, so it is not updated automatically. To replace it: muvloom skill install --host %s --scope %s",
				installed.Path, installed.Host, installed.Scope)
		}
	}
	var refreshFailures []map[string]string
	for _, item := range failed {
		a.progress("Could not update the muvloom Skill at %s to %s: %v", item.Path, skill.BundleVersion, item.Err)
		refreshFailures = append(refreshFailures, map[string]string{"path": item.Path, "error": item.Err.Error()})
	}
	store := a.Store.Describe()
	status := map[string]any{
		"cli_version":      Version,
		"api_url":          a.APIURL,
		"api_url_source":   a.apiURLSource,
		"credential_store": store.Backend,
		"skills":           skills,
	}
	if refreshErr != nil {
		status["skill_check_error"] = refreshErr.Error()
	}
	if len(refreshFailures) > 0 {
		status["skill_refresh_failures"] = refreshFailures
	}
	if store.KeychainIssue != "" {
		status["credential_store_issue"] = store.KeychainIssue
	}
	if leftovers := a.Store.Leftovers(); len(leftovers) > 0 {
		status["leftover_temp_files"] = len(leftovers)
	}
	if pending, err := a.Store.LoadPending(); err == nil && (time.Now().Before(pending.ExpiresAt) || pending.Redeemed && recoverable(pending)) && !completedLogin(a, pending) {
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
		if a.Store.DefaultLoginElsewhere() {
			a.progress("Since CLI 0.2.1, MUVLOOM_CONFIG_DIR (%s) keeps its own login in that directory and leaves the keychain login of the default directory alone. Run `muvloom auth login` to sign in here.", a.Store.Dir)
		}
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
	noWait := fs.Bool("no-wait", false, "Print the approval link and return without waiting (no browser)")
	timeout := fs.Int("timeout", -1, "Seconds to wait for approval; omitted: as long as the code is valid")
	switchService := fs.Bool("switch-service", false, "Sign in to MUVLOOM_API_URL although this machine is signed in to another service")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	pending, err := a.Store.LoadPending()
	// A code the server may already have redeemed, whose tokens never reached the credential
	// store, is redeemed again with the same request identity even after the code expired: the
	// service answers with the same tokens for an hour past expiry, or says no.
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
	if redeemed && !fresh {
		tokens, err := a.redeem(ctx, pending)
		if err == nil {
			return a.finishLogin(ctx, pending, tokens)
		}
		var oauthErr *client.OAuthError
		if !errors.As(err, &oauthErr) {
			return nil, err
		}
		switch oauthErr.Code {
		case "expired_token", "invalid_grant", "access_denied", "authorization_pending":
			// The service cannot repeat it (never redeemed, or no longer): start a new login.
			resuming = false
		default:
			// Busy or rate limited: keep the request identity for the next attempt.
			if oauthErr.Status == http.StatusTooManyRequests {
				return nil, fail("RATE_LIMITED", "Too many login attempts; wait a minute and retry")
			}
			return nil, fail("TEMPORARILY_UNAVAILABLE", "The service could not finish the login (%s); run `muvloom auth login` again shortly", oauthErr.Code)
		}
	}
	// Waiting in the foreground listens for the browser to come back; a port that cannot be
	// opened leaves the device code alone to finish the login.
	var listener net.Listener
	if !*noWait && (!resuming || pending.RedirectURI != "") {
		next := pending
		if !resuming {
			next = auth.PendingLogin{}
		}
		if l, err := a.startLoopback(&next); err == nil {
			listener = l
			pending.RedirectURI = next.RedirectURI
		} else if !resuming {
			pending.RedirectURI = ""
		}
	}
	if listener != nil {
		defer listener.Close()
	}
	if !resuming {
		form := url.Values{"client_id": {oauthClientID}}
		var verifier, state string
		if listener != nil {
			var err1, err2 error
			verifier, err1 = randomToken(32)
			state, err2 = randomToken(24)
			if err1 != nil || err2 != nil {
				return nil, fail("INTERNAL_ERROR", "Could not create a login challenge")
			}
			form.Set("redirect_uri", pending.RedirectURI)
			form.Set("code_challenge", pkceChallenge(verifier))
			form.Set("code_challenge_method", "S256")
		}
		redirectURI := pending.RedirectURI
		var device deviceAuthorization
		if err := a.anonymousClient().PostForm(ctx, "/v1/oauth/device_authorization", form, &device); err != nil {
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
		if listener != nil {
			pending.RedirectURI, pending.CodeVerifier, pending.State = redirectURI, verifier, state
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
		if *noWait {
			a.progress("Open %s and confirm code %s", pending.VerificationURIComplete, pending.UserCode)
			return prompt, nil
		}
		// A resumed login does not open another page: the one already open still works.
		if resuming {
			a.progress("Waiting for approval of code %s at %s", pending.UserCode, pending.VerificationURIComplete)
		} else if err := a.openBrowser(approvalURL(pending)); err == nil {
			a.progress("Opened the browser to approve this connection (code %s). Waiting…", pending.UserCode)
		} else {
			a.progress("Open %s and confirm code %s", pending.VerificationURIComplete, pending.UserCode)
		}
	}
	done := make(chan struct{})
	defer close(done)
	// A browser that came back while the code exchange hit a temporary error waits for the
	// final outcome, so it is never told "failed" when polling then signs in.
	var waiting *callback
	defer func() { waiting.answer(false) }()
	var callbacks <-chan callback
	if listener != nil && pending.State != "" {
		callbacks = a.serveCallback(listener, pending, done)
	}
	// By default the CLI waits as long as the code is valid: an approval page left open keeps
	// somewhere to come back to.
	// The service still redeems an approved code briefly after it expires.
	deadline := pending.ExpiresAt.Add(time.Minute)
	if *timeout >= 0 || !time.Now().Before(deadline) {
		deadline = time.Now().Add(seconds(*timeout, 0, 3600))
	}
	interval := seconds(pending.IntervalSeconds, 1, 60)
	for {
		tokens, err := a.redeem(ctx, pending)
		if err == nil {
			result, err := a.finishLogin(ctx, pending, tokens)
			waiting.answer(err == nil)
			waiting = nil
			return result, err
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
				// A busy or rate-limited service is not an answer: keep waiting.
				if oauthErr.Status < 500 && oauthErr.Status != http.StatusTooManyRequests {
					return nil, oauthFailure(err)
				}
			}
		}
		if time.Now().Add(interval).After(deadline) {
			return nil, &Failure{
				Code:    "AUTH_PENDING",
				Message: "Still waiting for browser approval; run `muvloom auth login` again to resume",
				Details: prompt,
			}
		}
		if visit, ok, err := a.waitForCallback(ctx, interval, callbacks); err != nil {
			return nil, err
		} else if ok {
			waiting.answer(false)
			waiting = &visit
			if result, err := a.completeCallback(ctx, &pending, waiting); err == nil {
				waiting = nil
				return result, nil
			} else if exitByCode[asFailure(err).Code] == ExitRejected {
				return nil, err
			}
			// The code did not work; the device code may still, so keep polling.
		}
	}
}

// waitForCallback sleeps until the next poll, or returns early when the browser comes back.
func (a *App) waitForCallback(ctx context.Context, interval time.Duration, callbacks <-chan callback) (callback, bool, error) {
	if callbacks == nil {
		return callback{}, false, a.Sleep(ctx, interval)
	}
	sleepCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	slept := make(chan error, 1)
	go func() { slept <- a.Sleep(sleepCtx, interval) }()
	select {
	case visit := <-callbacks:
		return visit, true, nil
	case err := <-slept:
		return callback{}, false, err
	}
}

// completeCallback redeems the code the browser brought back. The code is stored first: if the
// response is lost, running the command again repeats this exchange with the same identity.
func (a *App) completeCallback(ctx context.Context, pending *auth.PendingLogin, visit *callback) (any, error) {
	pending.AuthorizationCode = visit.code
	if err := a.Store.SavePending(*pending); err != nil {
		return nil, fail("CREDENTIAL_STORE_UNWRITABLE", "Could not store the pending login (%s); check that the muvloom config directory is writable", auth.Reason(err))
	}
	tokens, err := a.redeemAuthorizationCode(ctx, *pending)
	if err != nil {
		return nil, oauthFailure(err)
	}
	result, err := a.finishLogin(ctx, *pending, tokens)
	visit.answer(err == nil)
	return result, err
}

// approvalURL is the page the CLI opens: the device page for this code, carrying the state the
// page hands back with the one-time code.
func approvalURL(pending auth.PendingLogin) string {
	if pending.State == "" {
		return pending.VerificationURIComplete
	}
	target, err := url.Parse(pending.VerificationURIComplete)
	if err != nil {
		return pending.VerificationURIComplete
	}
	query := target.Query()
	query.Set("state", pending.State)
	target.RawQuery = query.Encode()
	return target.String()
}

func (a *App) redeemDeviceCode(ctx context.Context, pending auth.PendingLogin) (tokenResponse, error) {
	var tokens tokenResponse
	err := a.anonymousClient().PostForm(ctx, "/v1/oauth/token", url.Values{
		"client_id":   {oauthClientID},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"device_code": {pending.DeviceCode},
		"request_id":  {pending.RequestID},
	}, &tokens)
	return tokens, err
}

func (a *App) finishLogin(ctx context.Context, pending auth.PendingLogin, tokens tokenResponse) (any, error) {
	creds := a.credentialsFrom(tokens)
	creds.LoginDeviceCodeHash = deviceCodeHash(pending.DeviceCode)
	if err := a.Store.Save(creds); err != nil {
		// The pending login keeps its request identity, which is what it takes to get the same
		// tokens again; marking it redeemed only spares the user a stale approval prompt.
		pending.Redeemed = true
		_ = a.Store.SavePending(pending)
		return nil, fail("CREDENTIAL_STORE_UNWRITABLE", "Signed in, but the credentials could not be stored (%s); make the muvloom config directory writable, then run `muvloom auth login` again: it finishes without a new approval when the service supports it, otherwise it asks for one", auth.Reason(err))
	}
	_ = a.Store.ClearPending()
	a.progress("Signed in.")
	return cmdAuthStatus(ctx, a, nil)
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
func versionLess(current, minimum string) bool { return skill.VersionLess(current, minimum) }

// spelledAs returns the flag as the user wrote it (-x or --x), without any =value.
func spelledAs(args []string, name string) string {
	for _, arg := range args {
		spelled, _, _ := strings.Cut(arg, "=")
		if strings.TrimLeft(spelled, "-") == name && strings.HasPrefix(spelled, "-") {
			return spelled
		}
	}
	return "-" + name
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
			if errors.Is(err, flag.ErrHelp) {
				return nil, &helpRequest{flags: fs}
			}
			if name, ok := strings.CutPrefix(err.Error(), "flag provided but not defined: -"); ok {
				return nil, fail("USAGE", "unknown flag %s", spelledAs(args, name))
			}
			return nil, fail("USAGE", "%v", err)
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
