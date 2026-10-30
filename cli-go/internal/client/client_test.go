package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoRefreshesAfterUnauthorized(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/v1/auth/token/refresh" {
			_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"access_token":"new"}}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer new" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"schema_version":1,"ok":false,"error":{"code":"UNAUTHENTICATED","message":"Authentication is required"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"ok":true}}`))
	}))
	defer s.Close()
	c := New(s.URL, s.Client())
	c.AccessToken = "old"
	c.RefreshToken = func(ctx context.Context) (string, error) {
		var result struct {
			AccessToken string `json:"access_token"`
		}
		if err := c.DoWithoutRefresh(ctx, http.MethodPost, "/v1/auth/token/refresh", nil, &result); err != nil {
			return "", err
		}
		return result.AccessToken, nil
	}
	var out map[string]bool
	if err := c.Do(context.Background(), http.MethodGet, "/v1/test", nil, &out); err != nil {
		t.Fatal(err)
	}
	if !out["ok"] || calls != 3 {
		t.Fatalf("out=%v calls=%d", out, calls)
	}
}

func TestEnvelopeError(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":false,"error":{"code":"CONFLICT","message":"conflict"}}`))
	}))
	defer s.Close()
	c := New(s.URL, s.Client())
	err := c.Do(context.Background(), http.MethodGet, "/x", nil, nil)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != "CONFLICT" {
		t.Fatalf("%v", err)
	}
	_ = json.Valid
}
