package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRetriesOnceAfterRefresh(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"schema_version":1,"ok":false,"error":{"code":"UNAUTHENTICATED","message":"no"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":true,"data":{"ready":true}}`))
	}))
	defer server.Close()
	c := New(server.URL, nil)
	c.AccessToken = "stale"
	c.Refresh = func(context.Context, string) (string, error) { return "fresh", nil }
	var out struct{ Ready bool }
	if err := c.Do(context.Background(), http.MethodGet, "/v1/me", nil, &out); err != nil || !out.Ready {
		t.Fatalf("Do = %v, %+v", err, out)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
}

func TestReportsEnvelopeErrorsAndTransportFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"schema_version":1,"ok":false,"error":{"code":"MAX_CREDITS_EXCEEDED","message":"too much","details":{"required":10}}}`))
	}))
	c := New(server.URL, nil)
	err := c.Do(context.Background(), http.MethodPost, "/v1/image-jobs", map[string]any{}, nil)
	if !IsCode(err, "MAX_CREDITS_EXCEEDED") {
		t.Fatalf("err = %v", err)
	}
	server.Close()
	if err := c.Do(context.Background(), http.MethodGet, "/v1/me", nil, nil); !IsCode(err, "NETWORK_ERROR") {
		t.Fatalf("closed server err = %v", err)
	}
}
