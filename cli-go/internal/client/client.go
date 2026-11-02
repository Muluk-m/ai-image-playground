// Package client talks to the Muvloom CLI API. It never includes credential values in
// errors, so callers can print any error it returns.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const SchemaVersion = 1

type envelope struct {
	SchemaVersion int             `json:"schema_version"`
	OK            bool            `json:"ok"`
	Data          json.RawMessage `json:"data,omitempty"`
	Error         *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details,omitempty"`
	} `json:"error,omitempty"`
}

// APIError is a failure the server (or the transport) reported. Code is a stable
// machine-readable value; NETWORK_ERROR and INVALID_RESPONSE are produced locally.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details json.RawMessage
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// HTTPClient retries once after a 401 by asking Refresh for a new access token.
type HTTPClient struct {
	BaseURL     string
	HTTP        *http.Client
	AccessToken string
	Refresh     func(ctx context.Context, rejected string) (string, error)
	UserAgent   string
}

// NoRedirects stops a client from following redirects: a redirect could carry a bearer
// token, a refresh token form body or a local file to a host nobody chose.
func NoRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func New(baseURL string, hc *http.Client) *HTTPClient {
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	// Copy rather than mutate the caller's client, and always refuse redirects.
	copied := *hc
	copied.CheckRedirect = NoRedirects
	hc = &copied
	return &HTTPClient{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: hc}
}

// Do sends a JSON request to the CLI API and decodes the envelope's data into out.
func (c *HTTPClient) Do(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if c.UserAgent != "" {
			req.Header.Set("User-Agent", c.UserAgent)
		}
		if c.AccessToken != "" {
			req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		}
		status, data, err := c.send(req)
		if err != nil {
			return err
		}
		if status == http.StatusUnauthorized && attempt == 0 && c.Refresh != nil {
			if token, refreshErr := c.Refresh(ctx, c.AccessToken); refreshErr == nil && token != "" {
				c.AccessToken = token
				continue
			}
		}
		return decode(status, data, out)
	}
}

func (c *HTTPClient) send(req *http.Request) (int, []byte, error) {
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, &APIError{Code: "NETWORK_ERROR", Message: "Could not reach the Muvloom API"}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return 0, nil, &APIError{Code: "NETWORK_ERROR", Message: "The response was interrupted"}
	}
	return resp.StatusCode, data, nil
}

func decode(status int, data []byte, out any) error {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil || env.SchemaVersion == 0 {
		return &APIError{Status: status, Code: fallbackCode(status), Message: http.StatusText(status)}
	}
	if env.SchemaVersion != SchemaVersion {
		return &APIError{Status: status, Code: "UNSUPPORTED_VERSION", Message: "This CLI does not understand the server response; upgrade muvloom"}
	}
	if !env.OK || status >= 400 {
		if env.Error == nil {
			return &APIError{Status: status, Code: fallbackCode(status), Message: http.StatusText(status)}
		}
		return &APIError{Status: status, Code: env.Error.Code, Message: env.Error.Message, Details: env.Error.Details}
	}
	if out != nil && len(env.Data) != 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return &APIError{Status: status, Code: "INVALID_RESPONSE", Message: fmt.Sprintf("decode response: %v", err)}
		}
	}
	return nil
}

func fallbackCode(status int) string {
	switch {
	case status == 401:
		return "UNAUTHENTICATED"
	case status == 404:
		return "NOT_FOUND"
	case status == 429:
		return "RATE_LIMITED"
	case status >= 500 || status == 0:
		return "TEMPORARILY_UNAVAILABLE"
	default:
		return "INVALID_RESPONSE"
	}
}

// OAuthError is an RFC 6749 error from the token endpoints, e.g. authorization_pending.
type OAuthError struct {
	Status int
	Code   string
}

func (e *OAuthError) Error() string { return e.Code }

// PostForm calls an OAuth endpoint (form-encoded request, plain JSON response).
func (c *HTTPClient) PostForm(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	status, data, err := c.send(req)
	if err != nil {
		return err
	}
	if status >= 400 {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Error != "" {
			return &OAuthError{Status: status, Code: failure.Error}
		}
		return &APIError{Status: status, Code: fallbackCode(status), Message: http.StatusText(status)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &APIError{Status: status, Code: "INVALID_RESPONSE", Message: "The server returned an invalid response"}
	}
	return nil
}

// IsCode reports whether err is an APIError with the given code.
func IsCode(err error, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}
