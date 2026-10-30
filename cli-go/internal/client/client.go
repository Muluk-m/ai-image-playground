package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const SchemaVersion = 1

type Envelope struct {
	SchemaVersion int             `json:"schema_version"`
	OK            bool            `json:"ok"`
	Data          json.RawMessage `json:"data,omitempty"`
	Error         *EnvelopeError  `json:"error,omitempty"`
}

type EnvelopeError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// HTTPClient is the small, retrying client used by commands. It retries once after
// a 401 by calling RefreshToken, never printing or including token values in errors.
type HTTPClient struct {
	BaseURL      string
	HTTP         *http.Client
	AccessToken  string
	RefreshToken func(context.Context) (string, error)
}

func New(baseURL string, hc *http.Client) *HTTPClient {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &HTTPClient{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: hc}
}

func (c *HTTPClient) Do(ctx context.Context, method, path string, body any, out any) error {
	return c.do(ctx, method, path, body, out, true)
}

func (c *HTTPClient) DoWithoutRefresh(ctx context.Context, method, path string, body any, out any) error {
	return c.do(ctx, method, path, body, out, false)
}

func (c *HTTPClient) do(ctx context.Context, method, path string, body any, out any, allowRefresh bool) error {
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	payload, err := encodeBody(body)
	if err != nil {
		return err
	}
	attempts := 1
	if allowRefresh && c.RefreshToken != nil {
		attempts = 2
	}
	for attempt := range attempts {
		req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if c.AccessToken != "" {
			req.Header.Set("Authorization", "Bearer "+c.AccessToken)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return err
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil || env.SchemaVersion != SchemaVersion {
			return &APIError{Status: resp.StatusCode, Code: "INVALID_RESPONSE", Message: "The server returned an invalid response"}
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 && allowRefresh && c.RefreshToken != nil {
			token, refreshErr := c.RefreshToken(ctx)
			if refreshErr == nil && token != "" {
				c.AccessToken = token
				continue
			}
		}
		if !env.OK || resp.StatusCode >= 400 {
			if env.Error != nil {
				return &APIError{Status: resp.StatusCode, Code: env.Error.Code, Message: env.Error.Message}
			}
			return &APIError{Status: resp.StatusCode, Code: statusCode(resp.StatusCode), Message: http.StatusText(resp.StatusCode)}
		}
		if out != nil && len(env.Data) != 0 {
			if err := json.Unmarshal(env.Data, out); err != nil {
				return fmt.Errorf("decode response: %w", err)
			}
		}
		return nil
	}
	return errors.New("request failed")
}

func encodeBody(body any) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	return json.Marshal(body)
}
func statusCode(s int) string {
	switch s {
	case 401:
		return "UNAUTHENTICATED"
	case 403:
		return "FORBIDDEN"
	case 404:
		return "NOT_FOUND"
	case 409:
		return "CONFLICT"
	case 429:
		return "RATE_LIMITED"
	default:
		if s >= 500 {
			return "INTERNAL_ERROR"
		}
		return "REQUEST_REJECTED"
	}
}
