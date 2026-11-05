// Package updates checks official CLI releases without accessing account credentials.
package updates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

const releasesURL = "https://api.github.com/repos/Muluk-m/ai-image-playground/releases"
const releasePage = "https://github.com/Muluk-m/ai-image-playground/releases/tag/cli-v"

type Checker struct {
	Dir     string
	Version string
	HTTP    *http.Client
	Now     func() time.Time
}

type Result struct {
	Status         string    `json:"status"`
	CurrentVersion string    `json:"current_version"`
	LatestVersion  string    `json:"latest_version,omitempty"`
	ReleaseURL     string    `json:"release_url,omitempty"`
	CheckedAt      time.Time `json:"checked_at,omitempty"`
	Cached         bool      `json:"cached"`
	ShouldPrompt   bool      `json:"should_prompt"`
	Reason         string    `json:"reason,omitempty"`
}

type record struct {
	CheckedAt     time.Time `json:"checked_at"`
	LatestVersion string    `json:"latest_version,omitempty"`
	Reason        string    `json:"reason,omitempty"`
}

// Check caches attempts, including failures, for the user's local calendar day.
// A recorded attempt survives crashes; the lock prevents concurrent checks/prompts.
func (c Checker) Check(ctx context.Context) Result {
	result := Result{Status: "unavailable", CurrentVersion: c.Version}
	dir := filepath.Join(c.Dir, "updates")
	unlock, err := (auth.Store{Dir: dir}).Lock(time.Second)
	if err != nil {
		result.Reason = "check_in_progress_or_storage_unavailable"
		return result
	}
	defer unlock()
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	path := filepath.Join(dir, "check.json")
	var saved record
	if body, err := os.ReadFile(path); err == nil && json.Unmarshal(body, &saved) == nil &&
		!now.Before(saved.CheckedAt) && saved.CheckedAt.In(now.Location()).Format("2006-01-02") == now.Format("2006-01-02") {
		return resultFor(c.Version, saved, true)
	}
	saved = record{CheckedAt: now, Reason: "release_check_incomplete"}
	if err := save(path, saved); err != nil {
		result.Reason = "storage_unavailable"
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	saved.LatestVersion, err = c.latest(ctx)
	if err != nil {
		saved.Reason = "release_check_failed"
	} else {
		saved.Reason = ""
	}
	if err := save(path, saved); err != nil {
		result.CheckedAt, result.Reason = now, "storage_unavailable"
		return result
	}
	return resultFor(c.Version, saved, false)
}

func save(path string, value record) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return auth.WriteFileAtomic(path, body)
}

func resultFor(current string, saved record, cached bool) Result {
	result := Result{
		Status: "unavailable", CurrentVersion: current, LatestVersion: saved.LatestVersion,
		CheckedAt: saved.CheckedAt, Cached: cached, Reason: saved.Reason,
	}
	cur, ok := parseVersion(strings.TrimPrefix(current, "v"))
	latest, valid := parseVersion(saved.LatestVersion)
	if saved.Reason != "" || !ok || !valid {
		return result
	}
	result.Status = "up_to_date"
	if cur.less(latest) {
		result.Status = "update_available"
		result.ReleaseURL = releasePage + saved.LatestVersion
		result.ShouldPrompt = !cached
	}
	return result
}

type release struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

func (c Checker) latest(ctx context.Context) (string, error) {
	httpClient := http.Client{CheckRedirect: client.NoRedirects}
	if c.HTTP != nil {
		httpClient = *c.HTTP
		httpClient.CheckRedirect = client.NoRedirects
	}
	var highest version
	found := false
	for page := 1; page <= 20; page++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s?per_page=100&page=%d", releasesURL, page), nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "muvloom-cli/"+c.Version)
		resp, err := httpClient.Do(req)
		if err != nil {
			return "", err
		}
		var items []release
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return "", fmt.Errorf("release listing unavailable")
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
		resp.Body.Close()
		if err != nil || len(body) > 4*1024*1024 || json.Unmarshal(body, &items) != nil {
			return "", fmt.Errorf("invalid release listing")
		}
		for _, item := range items {
			if item.Draft || item.Prerelease || !strings.HasPrefix(item.Tag, "cli-v") {
				continue
			}
			candidate, ok := parseVersion(strings.TrimPrefix(item.Tag, "cli-v"))
			if ok && (!found || highest.less(candidate)) {
				highest, found = candidate, true
			}
		}
		if len(items) < 100 {
			if !found {
				return "", fmt.Errorf("no stable CLI release")
			}
			return highest.String(), nil
		}
	}
	return "", fmt.Errorf("release listing is incomplete")
}

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type version [3]uint64

func parseVersion(raw string) (version, bool) {
	var value version
	parts := stableVersion.FindStringSubmatch(raw)
	if parts == nil {
		return value, false
	}
	for i := range value {
		n, err := strconv.ParseUint(parts[i+1], 10, 64)
		if err != nil {
			return value, false
		}
		value[i] = n
	}
	return value, true
}

func (v version) less(other version) bool {
	for i := range v {
		if v[i] != other[i] {
			return v[i] < other[i]
		}
	}
	return false
}

func (v version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }
