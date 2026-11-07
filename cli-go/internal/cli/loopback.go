package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

// Loopback sign-in (RFC 8252 §7.3): the CLI listens on a random port of 127.0.0.1, registers
// that callback and a PKCE challenge with the device authorization, and opens the approval page
// itself. After the user approves, the page sends the browser back to the callback with a
// one-time code, and the CLI finishes at once. Device-code polling keeps running alongside, so
// a callback that never arrives (another device, a blocked port) still completes the login.

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (a *App) listen(addr string) (net.Listener, error) {
	if a.Listen != nil {
		return a.Listen("tcp", addr)
	}
	return net.Listen("tcp", addr)
}

// openBrowser opens url in the user's browser. MUVLOOM_NO_BROWSER=1 opts out, and so does a
// session with nothing to show a browser on.
func (a *App) openBrowser(target string) error {
	if a.OpenBrowser != nil {
		return a.OpenBrowser(target)
	}
	if os.Getenv("MUVLOOM_NO_BROWSER") == "1" {
		return errors.New("disabled")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errors.New("no display")
		}
		cmd = exec.Command("xdg-open", target)
	}
	// Start, do not wait: a browser that runs in the foreground would hold the login.
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// startLoopback listens for the callback. A login resumed in a new process listens on the port
// it registered before, so an approval in the page that is already open still comes back here.
func (a *App) startLoopback(pending *auth.PendingLogin) (net.Listener, error) {
	addr := "127.0.0.1:0"
	if pending.RedirectURI != "" {
		parsed, err := url.Parse(pending.RedirectURI)
		if err != nil {
			return nil, err
		}
		addr = parsed.Host
	}
	listener, err := a.listen(addr)
	if err != nil {
		return nil, err
	}
	if pending.RedirectURI == "" {
		port := listener.Addr().(*net.TCPAddr).Port
		pending.RedirectURI = "http://127.0.0.1:" + strconv.Itoa(port) + "/callback"
	}
	return listener, nil
}

// callback is one browser visit to the loopback address: the code it carries, and where the
// browser is sent once the CLI knows how the login went.
type callback struct {
	code  string
	reply chan bool
	// sent is closed once the browser has its answer, so the CLI does not exit before then.
	sent chan struct{}
}

// answer tells the waiting browser how the login ended and waits, briefly, until it is told.
func (c *callback) answer(ok bool) {
	if c == nil || c.reply == nil {
		return
	}
	select {
	case c.reply <- ok:
	default:
		return
	}
	select {
	case <-c.sent:
	case <-time.After(3 * time.Second):
	}
}

// serveCallback answers the callback of this login only: a visit whose state does not match is
// turned away without touching the login.
func (a *App) serveCallback(listener net.Listener, pending auth.PendingLogin, done <-chan struct{}) <-chan callback {
	codes := make(chan callback)
	page := func(status string) string {
		target, err := url.Parse(pending.VerificationURIComplete)
		if err != nil {
			return ""
		}
		return target.Scheme + "://" + target.Host + target.Path + "?status=" + status
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /callback", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		state, code := query.Get("state"), query.Get("code")
		if pending.State == "" || subtle.ConstantTimeCompare([]byte(state), []byte(pending.State)) != 1 || code == "" {
			http.Error(w, "This sign-in link does not belong to the waiting muvloom login.", http.StatusBadRequest)
			return
		}
		visit := callback{code: code, reply: make(chan bool, 1), sent: make(chan struct{})}
		defer close(visit.sent)
		select {
		case codes <- visit:
		case <-done:
			http.Error(w, "The muvloom login is no longer waiting.", http.StatusGone)
			return
		}
		ok := false
		select {
		case ok = <-visit.reply:
		case <-time.After(2 * time.Minute):
		case <-done:
		}
		status := "failed"
		if ok {
			status = "connected"
		}
		if target := page(status); target != "" {
			http.Redirect(w, r, target, http.StatusSeeOther)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	go func() {
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	return codes
}

func (a *App) redeemAuthorizationCode(ctx context.Context, pending auth.PendingLogin) (tokenResponse, error) {
	var tokens tokenResponse
	err := a.anonymousClient().PostForm(ctx, "/v1/oauth/token", url.Values{
		"client_id":     {oauthClientID},
		"grant_type":    {"authorization_code"},
		"code":          {pending.AuthorizationCode},
		"code_verifier": {pending.CodeVerifier},
		"redirect_uri":  {pending.RedirectURI},
		"request_id":    {pending.RequestID},
	}, &tokens)
	return tokens, err
}

// redeem finishes with whatever the login holds: the callback's one-time code when one arrived,
// otherwise the device code. Whenever the service turns the code down, for whatever reason, the
// device code decides.
func (a *App) redeem(ctx context.Context, pending auth.PendingLogin) (tokenResponse, error) {
	if pending.AuthorizationCode != "" && pending.CodeVerifier != "" {
		tokens, err := a.redeemAuthorizationCode(ctx, pending)
		var oauthErr *client.OAuthError
		if err == nil || !errors.As(err, &oauthErr) {
			return tokens, err
		}
	}
	return a.redeemDeviceCode(ctx, pending)
}
