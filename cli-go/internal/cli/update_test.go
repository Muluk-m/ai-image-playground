package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

type updateTransport func(*http.Request) (*http.Response, error)

func (f updateTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestUpdateCommandWorksWithoutLoginAndCachesItsResult(t *testing.T) {
	var out bytes.Buffer
	calls := 0
	a := &App{APIURL: DefaultAPIURL, Store: auth.Store{Dir: t.TempDir()}, Out: &out, Err: io.Discard}
	a.HTTP = &http.Client{Transport: updateTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "api.github.com" || req.Header.Get("Authorization") != "" {
			t.Fatalf("update used an account API or credential")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`[{"tag_name":"cli-v%s"}]`, Version)))}, nil
	})}
	for attempt := range 2 {
		out.Reset()
		if code := a.Run([]string{"--json", "update", "check"}); code != ExitOK {
			t.Fatalf("update check exit %d: %s", code, out.String())
		}
		var result struct {
			OK   bool `json:"ok"`
			Data struct {
				Status           string `json:"status"`
				Cached           bool   `json:"cached"`
				ShouldPrompt     bool   `json:"should_prompt"`
				InstallDirectory string `json:"install_directory"`
			} `json:"data"`
		}
		if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.OK || result.Data.Status != "up_to_date" || result.Data.Cached != (attempt == 1) || result.Data.ShouldPrompt || result.Data.InstallDirectory == "" {
			t.Fatalf("bad command response: %s", out.String())
		}
	}
	if calls != 1 {
		t.Fatalf("check re-fetched %d times", calls)
	}
}
