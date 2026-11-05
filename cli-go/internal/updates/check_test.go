package updates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func checker(t *testing.T, serve transport) Checker {
	t.Helper()
	return Checker{Dir: t.TempDir(), Version: "0.1.1", HTTP: &http.Client{Transport: serve}}
}

func response(body string, status int) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestDailyCheckAndNotificationUseLocalCalendarDay(t *testing.T) {
	var calls atomic.Int32
	c := checker(t, func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		if req.URL.Host != "api.github.com" || req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" {
			t.Errorf("unexpected release request: %s", req.URL)
		}
		return response(`[{"tag_name":"v99.0.0"},{"tag_name":"cli-v0.1.9"},{"tag_name":"cli-v0.1.10"},{"tag_name":"cli-v8.0.0-rc.1"},{"tag_name":"cli-v9.0.0","prerelease":true},{"tag_name":"cli-v10.0.0","draft":true}]`, 200), nil
	})
	now := time.Date(2026, 11, 5, 23, 30, 0, 0, time.FixedZone("UTC+8", 8*3600))
	c.Now = func() time.Time { return now }
	first := c.Check(context.Background())
	if first.Status != "update_available" || first.LatestVersion != "0.1.10" || !first.ShouldPrompt || first.Cached {
		t.Fatalf("first check: %+v", first)
	}
	now = now.Add(10 * time.Minute)
	second := c.Check(context.Background())
	if !second.Cached || second.ShouldPrompt || calls.Load() != 1 {
		t.Fatalf("same-day check re-fetched or re-prompted: %+v, calls=%d", second, calls.Load())
	}
	now = now.Add(30 * time.Minute)
	third := c.Check(context.Background())
	if third.Cached || !third.ShouldPrompt || calls.Load() != 2 {
		t.Fatalf("new local day: %+v, calls=%d", third, calls.Load())
	}
	// A binary upgraded after the check must not offer the same update again.
	c.Version = "0.1.10"
	if updated := c.Check(context.Background()); updated.Status != "up_to_date" || updated.ShouldPrompt || calls.Load() != 2 {
		t.Fatalf("updated binary ignored cached release: %+v", updated)
	}
}

func TestFailedCheckIsCachedUntilNextDay(t *testing.T) {
	var calls atomic.Int32
	c := checker(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return response("rate limited", 403), nil
	})
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	c.Now = func() time.Time { return now }
	first, second := c.Check(context.Background()), c.Check(context.Background())
	if first.Status != "unavailable" || first.ShouldPrompt || !second.Cached || calls.Load() != 1 {
		t.Fatalf("failure retry storm: %+v %+v calls=%d", first, second, calls.Load())
	}
	now = now.Add(24 * time.Hour)
	c.Check(context.Background())
	if calls.Load() != 2 {
		t.Fatal("failure was never retried on the next day")
	}
}

func TestConcurrentStartsCheckAndPromptOnlyOnce(t *testing.T) {
	var calls, prompts atomic.Int32
	c := checker(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return response(`[{"tag_name":"cli-v0.2.0"}]`, 200), nil
	})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if c.Check(context.Background()).ShouldPrompt {
				prompts.Add(1)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || prompts.Load() != 1 {
		t.Fatalf("concurrent calls=%d prompts=%d", calls.Load(), prompts.Load())
	}
}

func TestCheckPaginatesPastProductReleases(t *testing.T) {
	c := checker(t, func(req *http.Request) (*http.Response, error) {
		page, _ := strconv.Atoi(req.URL.Query().Get("page"))
		if page == 1 {
			items := make([]release, 100)
			for i := range items {
				items[i].Tag = fmt.Sprintf("v0.4.%d", i)
			}
			body, _ := json.Marshal(items)
			return response(string(body), 200), nil
		}
		return response(`[{"tag_name":"cli-v0.2.0"}]`, 200), nil
	})
	if result := c.Check(context.Background()); result.LatestVersion != "0.2.0" || !result.ShouldPrompt {
		t.Fatalf("CLI release behind product releases was missed: %+v", result)
	}
}

func TestReleaseChecksRejectRedirects(t *testing.T) {
	var calls atomic.Int32
	c := checker(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		res := response("", http.StatusFound)
		res.Header.Set("Location", "https://untrusted.example/releases")
		return res, nil
	})
	result := c.Check(context.Background())
	if result.Status != "unavailable" || result.ShouldPrompt || calls.Load() != 1 {
		t.Fatalf("redirect followed: %+v calls=%d", result, calls.Load())
	}
}

func TestCheckNeverOffersDowngradeOrUnpublishedVersions(t *testing.T) {
	for _, body := range []string{`[{"tag_name":"cli-v0.1.0"}]`, `[{"tag_name":"cli-v1.0.0-rc.1"}]`, `[{"tag_name":"cli-v999999999999999999999999.0.0"}]`, `not JSON`} {
		t.Run(body, func(t *testing.T) {
			c := checker(t, func(*http.Request) (*http.Response, error) { return response(body, 200), nil })
			if result := c.Check(context.Background()); result.ShouldPrompt || result.Status == "update_available" {
				t.Fatalf("invalid upgrade offered: %+v", result)
			}
		})
	}
}
