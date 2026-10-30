package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

const schemaVersion = 1

const Version = "0.1.0"

type outputEnvelope struct {
	SchemaVersion int          `json:"schema_version"`
	OK            bool         `json:"ok"`
	Data          any          `json:"data,omitempty"`
	Error         *outputError `json:"error,omitempty"`
}
type outputError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type App struct {
	BaseURL string
	Store   auth.Store
	HTTP    *http.Client
	Out     io.Writer
	Err     io.Writer
}

func New(baseURL string, store auth.Store, out, err io.Writer) *App {
	return &App{BaseURL: strings.TrimRight(baseURL, "/"), Store: store, HTTP: &http.Client{Timeout: 30 * time.Second}, Out: out, Err: err}
}

func (a *App) Run(args []string) int {
	if a.Out == nil {
		a.Out = io.Discard
	}
	if a.Err == nil {
		a.Err = io.Discard
	}
	if len(args) == 0 {
		return a.fail(2, "INVALID_REQUEST", "A command is required")
	}
	creds, credErr := a.Store.Load()
	c := client.New(a.BaseURL, a.HTTP)
	if credErr == nil {
		c.AccessToken = creds.AccessToken
		c.RefreshToken = func(ctx context.Context) (string, error) {
			if creds.RefreshToken == "" {
				return "", errors.New("no refresh token")
			}
			var refreshed struct {
				AccessToken  string `json:"access_token"`
				ExpiresIn    int    `json:"expires_in"`
				RefreshToken string `json:"refresh_token"`
			}
			if err := postForm(ctx, a.BaseURL+"/oauth/token", a.HTTP, map[string]string{"grant_type": "refresh_token", "refresh_token": creds.RefreshToken, "client_id": "muvloom-cli"}, &refreshed); err != nil {
				return "", err
			}
			if refreshed.AccessToken == "" {
				return "", errors.New("refresh returned no access token")
			}
			creds.AccessToken = refreshed.AccessToken
			if refreshed.RefreshToken != "" {
				creds.RefreshToken = refreshed.RefreshToken
			}
			if refreshed.ExpiresIn > 0 {
				creds.ExpiresAt = time.Now().Add(time.Duration(refreshed.ExpiresIn) * time.Second)
			}
			if err := a.Store.Save(creds); err != nil {
				return "", err
			}
			return creds.AccessToken, nil
		}
	}
	cmd := args[0]
	switch cmd {
	case "version":
		if len(args) != 1 {
			return a.fail(2, "INVALID_REQUEST", "Usage: version")
		}
		return a.success(map[string]any{"version": Version})
	case "auth":
		return a.auth(args[1:], creds, credErr)
	case "capabilities":
		if len(args) != 1 {
			return a.fail(2, "INVALID_REQUEST", "Usage: capabilities")
		}
		var data any
		if err := c.Do(context.Background(), http.MethodGet, "/v1/capabilities", nil, &data); err != nil {
			return a.apiFail(err)
		}
		return a.success(data)
	case "jobs":
		return a.jobs(c, args[1:])
	case "images":
		return a.images(c, args[1:])
	case "media":
		return a.media(c, args[1:])
	case "artifacts":
		return a.artifacts(c, args[1:])
	case "skill":
		return a.skill(args[1:])
	default:
		return a.fail(2, "INVALID_REQUEST", "Unknown command")
	}
}

func (a *App) media(c *client.HTTPClient, args []string) int {
	if len(args) == 0 {
		return a.fail(2, "INVALID_REQUEST", "Usage: media upload <path> | media list | media get <media_id> | media download <media_id> <path>")
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return a.fail(2, "INVALID_REQUEST", "Usage: media list")
		}
		var data any
		if err := c.Do(context.Background(), http.MethodGet, "/v1/media", nil, &data); err != nil {
			return a.apiFail(err)
		}
		return a.success(data)
	case "get", "download":
		if (args[0] == "get" && len(args) != 2) || (args[0] == "download" && len(args) != 3) {
			return a.fail(2, "INVALID_REQUEST", "Usage: media get <media_id> | media download <media_id> <path>")
		}
		var data struct {
			MediaID     string `json:"media_id"`
			DownloadURL string `json:"download_url"`
			ContentType string `json:"content_type"`
			Bytes       int    `json:"bytes"`
			ExpiresAt   int64  `json:"expires_at"`
		}
		path := "/v1/media/" + urlPath(args[1])
		if args[0] == "download" {
			path += "/download"
		}
		if err := c.Do(context.Background(), http.MethodGet, path, nil, &data); err != nil {
			return a.apiFail(err)
		}
		if args[0] == "get" {
			return a.success(data)
		}
		body, err := fetchURL(context.Background(), a.HTTP, data.DownloadURL)
		if err != nil {
			return a.fail(1, "LOCAL_IO_ERROR", "Could not download media")
		}
		if err := saveDownload(args[2], body); err != nil {
			return a.fail(1, "LOCAL_IO_ERROR", "Could not save downloaded media")
		}
		return a.success(map[string]any{"media_id": data.MediaID, "path": args[2], "bytes": len(body)})
	case "upload":
		if len(args) != 2 {
			return a.fail(2, "INVALID_REQUEST", "Usage: media upload <path>")
		}
		body, err := os.ReadFile(args[1])
		if err != nil {
			return a.fail(1, "LOCAL_IO_ERROR", "Could not read media file")
		}
		contentType := http.DetectContentType(body)
		if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/webp" {
			return a.fail(2, "INVALID_REQUEST", "Only PNG, JPEG, and WebP media are supported")
		}
		sum := sha256.Sum256(body)
		var reserved struct {
			MediaID   string `json:"media_id"`
			UploadURL string `json:"upload_url"`
			ExpiresAt int64  `json:"expires_at"`
			Status    string `json:"status"`
		}
		if err := c.Do(context.Background(), http.MethodPost, "/v1/media", map[string]any{"sha256": hex.EncodeToString(sum[:]), "bytes": len(body), "content_type": contentType}, &reserved); err != nil {
			return a.apiFail(err)
		}
		if reserved.Status != "ready" && reserved.UploadURL != "" {
			if err := putURL(context.Background(), a.HTTP, reserved.UploadURL, body, contentType); err != nil {
				return a.fail(1, "LOCAL_IO_ERROR", "Could not upload media")
			}
			if err := c.Do(context.Background(), http.MethodPost, "/v1/media/"+urlPath(reserved.MediaID)+"/complete", nil, &reserved); err != nil {
				return a.apiFail(err)
			}
		}
		return a.success(reserved)
	default:
		return a.fail(2, "INVALID_REQUEST", "Unknown media command")
	}
}

func (a *App) artifacts(c *client.HTTPClient, args []string) int {
	if len(args) < 2 || (args[0] != "get" && args[0] != "download") || (args[0] == "download" && len(args) != 3) || (args[0] == "get" && len(args) != 2) {
		return a.fail(2, "INVALID_REQUEST", "Usage: artifacts get <artifact_id> | artifacts download <artifact_id> <path>")
	}
	var data struct {
		ArtifactID  string `json:"artifact_id"`
		DownloadURL string `json:"download_url"`
		ContentType string `json:"content_type"`
		Bytes       int    `json:"bytes"`
		ExpiresAt   int64  `json:"expires_at"`
	}
	path := "/v1/artifacts/" + urlPath(args[1])
	if args[0] == "download" {
		path += "/download"
	}
	if err := c.Do(context.Background(), http.MethodGet, path, nil, &data); err != nil {
		return a.apiFail(err)
	}
	if args[0] == "get" {
		return a.success(data)
	}
	body, err := fetchURL(context.Background(), a.HTTP, data.DownloadURL)
	if err != nil {
		return a.fail(1, "LOCAL_IO_ERROR", "Could not download artifact")
	}
	if err := saveDownload(args[2], body); err != nil {
		return a.fail(1, "LOCAL_IO_ERROR", "Could not save downloaded artifact")
	}
	return a.success(map[string]any{"artifact_id": data.ArtifactID, "path": args[2], "bytes": len(body)})
}

func saveDownload(path string, body []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".muvloom-download-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() { _ = temp.Close(); _ = os.Remove(tempName) }
	if err := temp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := temp.Write(body); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Link(tempName, path); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return os.Remove(tempName)
}

func (a *App) skill(args []string) int {
	if len(args) == 0 || args[0] != "install" {
		return a.fail(2, "INVALID_REQUEST", "Usage: skill install --host claude-code|codex [--scope user|project]")
	}
	fs := flag.NewFlagSet("skill install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	host := fs.String("host", "", "agent host")
	scope := fs.String("scope", "user", "installation scope")
	if err := fs.Parse(args[1:]); err != nil {
		return a.fail(2, "INVALID_REQUEST", "Invalid skill install options")
	}
	if *host != "claude-code" && *host != "codex" {
		return a.fail(2, "INVALID_REQUEST", "--host must be claude-code or codex")
	}
	if *scope != "user" && *scope != "project" {
		return a.fail(2, "INVALID_REQUEST", "--scope must be user or project")
	}
	result, err := skill.Install(skill.InstallOptions{Host: *host, Scope: *scope})
	if err != nil {
		return a.fail(1, "SKILL_INSTALL_FAILED", err.Error())
	}
	return a.success(result)
}

func fetchURL(ctx context.Context, hc *http.Client, target string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 100<<20))
}

func putURL(ctx context.Context, hc *http.Client, target string, body []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("upload status %d", resp.StatusCode)
	}
	return nil
}

func (a *App) auth(args []string, creds auth.Credentials, credErr error) int {
	if (len(args) == 1 && args[0] == "status") || (len(args) == 2 && args[0] == "status" && args[1] == "--json") {
		data := map[string]any{"authenticated": false}
		if installed, installErr := skill.Installed("", ""); installErr == nil {
			data["skills"] = installed
		}
		if credErr == nil && creds.AccessToken != "" {
			data["authenticated"] = true
			if !creds.ExpiresAt.IsZero() {
				data["expires_at"] = creds.ExpiresAt.UTC().Format(time.RFC3339)
			}
		}
		return a.success(data)
	}
	if len(args) == 2 && args[0] == "login" && args[1] == "--start" {
		return a.loginStart()
	}
	if len(args) == 2 && args[0] == "login" && args[1] == "--resume" {
		return a.loginResume(creds, credErr)
	}
	if len(args) == 1 && args[0] == "logout" {
		return a.logout(creds, credErr)
	}
	return a.fail(2, "INVALID_REQUEST", "Usage: auth status [--json] | auth login --start | auth login --resume | auth logout")
}

func (a *App) loginStart() int {
	var result struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if err := postForm(context.Background(), a.BaseURL+"/oauth/device_authorization", a.HTTP, map[string]string{"client_id": "muvloom-cli"}, &result); err != nil {
		return a.apiFail(err)
	}
	interval := time.Duration(result.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	c := auth.Credentials{DeviceCode: result.DeviceCode, UserCode: result.UserCode, VerificationURI: result.VerificationURI, DeviceExpiresAt: time.Now().Add(time.Duration(result.ExpiresIn) * time.Second), PollInterval: interval}
	if err := a.Store.Save(c); err != nil {
		return a.fail(1, "INTERNAL_ERROR", "Could not save credentials")
	}
	return a.success(map[string]any{"user_code": result.UserCode, "verification_uri": result.VerificationURI, "expires_in": result.ExpiresIn})
}

func (a *App) loginResume(creds auth.Credentials, credErr error) int {
	if credErr != nil || creds.DeviceCode == "" {
		return a.fail(2, "INVALID_REQUEST", "No pending login; run auth login --start first")
	}
	deadline := creds.DeviceExpiresAt
	if deadline.IsZero() {
		deadline = time.Now().Add(10 * time.Minute)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	interval := creds.PollInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	for {
		var tok struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
		}
		err := postForm(ctx, a.BaseURL+"/oauth/token", a.HTTP, map[string]string{"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": creds.DeviceCode, "client_id": "muvloom-cli"}, &tok)
		if err == nil {
			if tok.AccessToken == "" {
				return a.fail(1, "INVALID_RESPONSE", "Authentication response was invalid")
			}
			creds.AccessToken, creds.RefreshToken, creds.ExpiresAt = tok.AccessToken, tok.RefreshToken, time.Now().Add(time.Duration(tok.ExpiresIn)*time.Second)
			creds.DeviceCode, creds.UserCode, creds.VerificationURI, creds.DeviceExpiresAt, creds.PollInterval = "", "", "", time.Time{}, 0
			if saveErr := a.Store.Save(creds); saveErr != nil {
				return a.fail(1, "INTERNAL_ERROR", "Could not save credentials")
			}
			return a.success(map[string]any{"authenticated": true, "expires_at": creds.ExpiresAt.UTC().Format(time.RFC3339)})
		}
		var apiErr *client.APIError
		if !errors.As(err, &apiErr) || (apiErr.Code != "AUTHORIZATION_PENDING" && apiErr.Code != "SLOW_DOWN") {
			return a.apiFail(err)
		}
		if apiErr.Code == "SLOW_DOWN" {
			interval += 5 * time.Second
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return a.fail(1, "AUTHORIZATION_TIMEOUT", "Device authorization timed out")
		case <-timer.C:
		}
	}
}

func (a *App) logout(creds auth.Credentials, credErr error) int {
	if credErr == nil && creds.RefreshToken != "" {
		_ = postForm(context.Background(), a.BaseURL+"/oauth/revoke", a.HTTP, map[string]string{"token": creds.RefreshToken, "client_id": "muvloom-cli"}, nil)
	}
	if err := a.Store.Clear(); err != nil {
		return a.fail(1, "INTERNAL_ERROR", "Could not clear credentials")
	}
	return a.success(map[string]any{"authenticated": false})
}

func postForm(ctx context.Context, endpoint string, hc *http.Client, values map[string]string, out any) error {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	form := url.Values{}
	for k, v := range values {
		form.Set(k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		var oauthErr struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &oauthErr) == nil && oauthErr.Error != "" {
			return &client.APIError{Status: resp.StatusCode, Code: strings.ToUpper(strings.ReplaceAll(oauthErr.Error, "-", "_")), Message: "Authentication request was rejected"}
		}
		return &client.APIError{Status: resp.StatusCode, Code: "REQUEST_REJECTED", Message: "Authentication request was rejected"}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (a *App) jobs(c *client.HTTPClient, args []string) int {
	if len(args) == 0 {
		return a.fail(2, "INVALID_REQUEST", "Usage: jobs get <job_id> | jobs list")
	}
	switch args[0] {
	case "get":
		if len(args) != 2 || args[1] == "" {
			return a.fail(2, "INVALID_REQUEST", "Usage: jobs get <job_id>")
		}
		var data any
		if err := c.Do(context.Background(), http.MethodGet, "/v1/jobs/"+urlPath(args[1]), nil, &data); err != nil {
			return a.apiFail(err)
		}
		return a.success(data)
	case "list":
		if len(args) != 1 {
			return a.fail(2, "INVALID_REQUEST", "Usage: jobs list")
		}
		var data any
		if err := c.Do(context.Background(), http.MethodGet, "/v1/jobs", nil, &data); err != nil {
			return a.apiFail(err)
		}
		return a.success(data)
	default:
		return a.fail(2, "INVALID_REQUEST", "Unknown jobs command")
	}
}

func (a *App) images(c *client.HTTPClient, args []string) int {
	if len(args) == 0 || args[0] != "create" {
		return a.fail(2, "INVALID_REQUEST", "Usage: images create --prompt <text> [--dry-run] [--idempotency <key>] [--max-credits <n>]")
	}
	fs := flag.NewFlagSet("images create", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	prompt := fs.String("prompt", "", "image prompt")
	dryRun := fs.Bool("dry-run", false, "validate without creating")
	idem := fs.String("idempotency", "", "idempotency key")
	maxCredits := fs.Int("max-credits", 0, "maximum credits")
	if err := fs.Parse(args[1:]); err != nil {
		return a.fail(2, "INVALID_REQUEST", "Invalid images create options")
	}
	if *prompt == "" {
		return a.fail(2, "INVALID_REQUEST", "--prompt is required")
	}
	body := map[string]any{"prompt": *prompt}
	if *idem != "" {
		body["idempotency_key"] = *idem
	}
	if *maxCredits > 0 {
		body["max_credits"] = *maxCredits
	}
	path := "/v1/image-jobs"
	if *dryRun {
		path += "/validate"
	}
	var data any
	if err := c.Do(context.Background(), http.MethodPost, path, body, &data); err != nil {
		return a.apiFail(err)
	}
	return a.success(data)
}

func urlPath(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "%", "%25"), "/", "%2F")
}
func (a *App) success(data any) int {
	return a.write(outputEnvelope{SchemaVersion: schemaVersion, OK: true, Data: data}, 0)
}
func (a *App) fail(code int, apiCode, message string) int {
	return a.write(outputEnvelope{SchemaVersion: schemaVersion, OK: false, Error: &outputError{Code: apiCode, Message: message}}, code)
}
func (a *App) apiFail(err error) int {
	var e *client.APIError
	if errors.As(err, &e) {
		return a.fail(exitCode(e.Code, e.Status), e.Code, e.Message)
	}
	return a.fail(1, "INTERNAL_ERROR", "The request could not be completed")
}
func (a *App) write(v outputEnvelope, code int) int {
	b, _ := json.Marshal(v)
	_, _ = fmt.Fprintln(a.Out, string(b))
	return code
}
func exitCode(code string, status int) int {
	switch code {
	case "UNAUTHENTICATED":
		return 3
	case "FORBIDDEN":
		return 4
	case "NOT_FOUND":
		return 5
	case "CONFLICT":
		return 6
	case "RATE_LIMITED":
		return 7
	}
	if status == 401 {
		return 3
	}
	if status >= 400 && status < 500 {
		return 2
	}
	return 1
}

func ParseBaseURL() string {
	if v := os.Getenv("MUVLOOM_API_URL"); v != "" {
		return v
	}
	return "https://api.muvloom.com"
}
func ParseStore() auth.Store { return auth.New(os.Getenv("MUVLOOM_CREDENTIALS_FILE")) }
func ParseInt(s string) int  { n, _ := strconv.Atoi(s); return n }
