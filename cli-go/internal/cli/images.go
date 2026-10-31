package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

func cmdCapabilities(ctx context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("capabilities"), args, 0); err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodGet, "/v1/capabilities", nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}

type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

type imageFlags struct {
	prompt, promptFile, model, aspectRatio, imageSize, quality string
	refs                                                       stringList
	maxCredits                                                 int
}

func bindImageFlags(fs *flag.FlagSet) *imageFlags {
	f := &imageFlags{}
	fs.StringVar(&f.prompt, "prompt", "", "what to generate")
	fs.StringVar(&f.promptFile, "prompt-file", "", "read the prompt from a UTF-8 file")
	fs.StringVar(&f.model, "model", "", "model id from `muvloom capabilities` (default: server default)")
	fs.StringVar(&f.aspectRatio, "aspect-ratio", "", "e.g. 1:1, 16:9, auto")
	fs.StringVar(&f.imageSize, "image-size", "", "e.g. 1K, 2K, 4K")
	fs.StringVar(&f.quality, "quality", "", "quality value the model lists")
	fs.Var(&f.refs, "ref", "reference image: a media_id or a local image file (repeatable)")
	fs.IntVar(&f.maxCredits, "max-credits", -1, "reject the request if it would cost more credits")
	return f
}

// body uploads local reference files first, so the request only carries media ids.
func (f *imageFlags) body(ctx context.Context, a *App, c *client.HTTPClient) (map[string]any, error) {
	prompt := f.prompt
	if f.promptFile != "" {
		data, err := os.ReadFile(f.promptFile)
		if err != nil {
			return nil, fail("INVALID_REQUEST", "Cannot read --prompt-file: %v", err)
		}
		prompt = string(data)
	}
	if strings.TrimSpace(prompt) == "" {
		return nil, fail("USAGE", "--prompt or --prompt-file is required")
	}
	body := map[string]any{"prompt": prompt}
	for key, value := range map[string]string{
		"model": f.model, "aspect_ratio": f.aspectRatio, "image_size": f.imageSize, "quality": f.quality,
	} {
		if value != "" {
			body[key] = value
		}
	}
	if f.maxCredits >= 0 {
		body["max_credits"] = f.maxCredits
	}
	if len(f.refs) > 0 {
		ids := make([]string, 0, len(f.refs))
		for _, ref := range f.refs {
			if info, err := os.Stat(ref); err == nil && !info.IsDir() {
				media, err := a.uploadMedia(ctx, c, ref)
				if err != nil {
					return nil, err
				}
				ids = append(ids, media.MediaID)
				continue
			}
			ids = append(ids, ref)
		}
		body["reference_media_ids"] = ids
	}
	return body, nil
}

func cmdImagesValidate(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("images validate")
	flags := bindImageFlags(fs)
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	body, err := flags.body(ctx, a, c)
	if err != nil {
		return nil, err
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodPost, "/v1/image-jobs/validate", body, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// submission is the local record written before a create request is sent, so a lost
// response can be recovered with `muvloom jobs list --idempotency-key KEY`.
type submission struct {
	IdempotencyKey string         `json:"idempotency_key"`
	Request        map[string]any `json:"request"`
	CreatedAt      time.Time      `json:"created_at"`
	JobID          string         `json:"job_id,omitempty"`
}

func (a *App) saveSubmission(record submission) {
	data, err := json.Marshal(record)
	if err == nil {
		// The key was validated, but a colon is not a valid file name character on Windows.
		name := strings.ReplaceAll(record.IdempotencyKey, ":", "_")
		path := filepath.Join(a.Store.Dir, "submissions", name+".json")
		if err := auth.WriteFileAtomic(path, data); err != nil {
			a.progress("Could not record the submission locally: %v", err)
		}
	}
}

// idempotencyKeyPattern matches the server's rule and keeps the key safe as a file name.
var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{8,64}$`)

func newIdempotencyKey() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fail("INTERNAL_ERROR", "Could not generate an idempotency key: %v", err)
	}
	return "cli-" + hex.EncodeToString(buf), nil
}

type createResult struct {
	Job            job             `json:"job"`
	RequestHash    string          `json:"request_hash"`
	Adjustments    json.RawMessage `json:"adjustments"`
	IdempotencyKey string          `json:"idempotency_key"`
	WaitTimedOut   bool            `json:"wait_timed_out,omitempty"`
	Downloads      []download      `json:"downloads,omitempty"`
}

func cmdImagesCreate(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("images create")
	flags := bindImageFlags(fs)
	key := fs.String("idempotency-key", "", "reuse a key to retry the same request safely (default: generated)")
	wait := fs.Int("wait", 0, "wait up to SECONDS (max 3600) for the job to finish")
	downloadDir := fs.String("download", "", "after a successful wait, save artifacts into DIR")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	body, err := flags.body(ctx, a, c)
	if err != nil {
		return nil, err
	}
	if *key == "" {
		if *key, err = newIdempotencyKey(); err != nil {
			return nil, err
		}
	} else if !idempotencyKeyPattern.MatchString(*key) || strings.Contains(*key, "..") {
		return nil, fail("USAGE", "--idempotency-key must be 8-64 characters of letters, digits, _ . : -")
	}
	body["idempotency_key"] = *key
	record := submission{IdempotencyKey: *key, Request: body, CreatedAt: time.Now()}
	a.saveSubmission(record)

	var result createResult
	// Same key, same body: a retry after a lost response returns the original job.
	for attempt := 0; ; attempt++ {
		err = c.Do(ctx, http.MethodPost, "/v1/image-jobs", body, &result)
		if err == nil || attempt == 2 || exitByCode[asFailure(err).Code] != ExitTemporary {
			break
		}
		a.progress("Submit failed (%s); retrying with the same idempotency key", asFailure(err).Code)
		if sleepErr := a.Sleep(ctx, time.Duration(attempt+1)*2*time.Second); sleepErr != nil {
			return nil, sleepErr
		}
	}
	if err != nil {
		if failure := asFailure(err); exitByCode[failure.Code] == ExitTemporary {
			failure.Details = map[string]string{"idempotency_key": *key}
			return nil, failure
		}
		return nil, err
	}
	result.IdempotencyKey = *key
	record.JobID = result.Job.JobID
	a.saveSubmission(record)
	if *wait <= 0 {
		return result, nil
	}
	final, timedOut, err := a.waitJob(ctx, c, result.Job.JobID, seconds(*wait, 0, 3600))
	if err != nil {
		return nil, err
	}
	result.Job, result.WaitTimedOut = final, timedOut
	if *downloadDir != "" && final.Status == "succeeded" {
		for _, artifact := range final.Artifacts {
			saved, err := a.downloadTo(ctx, c, "/v1/artifacts/"+url.PathEscape(artifact.ArtifactID)+"/download",
				filepath.Join(*downloadDir, artifact.ArtifactID))
			if err != nil {
				return nil, err
			}
			result.Downloads = append(result.Downloads, saved)
		}
	}
	return result, nil
}

type job struct {
	JobID                string `json:"job_id"`
	Status               string `json:"status"`
	Terminal             bool   `json:"terminal"`
	NextPollAfterSeconds int    `json:"next_poll_after_seconds,omitempty"`
	Artifacts            []struct {
		ArtifactID  string `json:"artifact_id"`
		MediaID     string `json:"media_id"`
		ContentType string `json:"content_type"`
	} `json:"artifacts,omitempty"`
	raw json.RawMessage
}

func (j *job) UnmarshalJSON(data []byte) error {
	type plain job
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*j = job(decoded)
	j.raw = append(json.RawMessage(nil), data...)
	return nil
}

// MarshalJSON passes the server's job object through unchanged.
func (j job) MarshalJSON() ([]byte, error) {
	if j.raw != nil {
		return j.raw, nil
	}
	type plain job
	return json.Marshal(plain(j))
}

// waitJob polls until the job is terminal or the deadline passes. Hitting the deadline
// is not an error: the job keeps running on the server and can be queried later.
func (a *App) waitJob(ctx context.Context, c *client.HTTPClient, id string, budget time.Duration) (job, bool, error) {
	deadline := time.Now().Add(budget)
	for {
		var current job
		if err := c.Do(ctx, http.MethodGet, "/v1/jobs/"+url.PathEscape(id), nil, &current); err != nil {
			return job{}, false, err
		}
		if current.Terminal {
			return current, false, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return current, true, nil
		}
		interval := seconds(current.NextPollAfterSeconds, 1, 10)
		a.progress("Job %s is %s", id, current.Status)
		if err := a.Sleep(ctx, min(interval, maxPollInterval, remaining)); err != nil {
			return job{}, false, err
		}
	}
}

func jobID(args []string) string { return url.PathEscape(args[0]) }

func cmdJobsGet(ctx context.Context, a *App, args []string) (any, error) {
	rest, err := parse(newFlags("jobs get"), args, 1)
	if err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodGet, "/v1/jobs/"+jobID(rest), nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func cmdJobsList(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("jobs list")
	limit := fs.Int("limit", 20, "1-50")
	cursor := fs.String("cursor", "", "next_cursor from the previous page")
	key := fs.String("idempotency-key", "", "find the job submitted with this key")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	query := url.Values{"limit": {strconv.Itoa(*limit)}}
	if *cursor != "" {
		query.Set("cursor", *cursor)
	}
	if *key != "" {
		query.Set("idempotency_key", *key)
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodGet, "/v1/jobs?"+query.Encode(), nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func cmdJobsWait(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("jobs wait")
	timeout := fs.Int("timeout", 300, "seconds to wait before returning the current state")
	rest, err := parse(fs, args, 1)
	if err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	final, timedOut, err := a.waitJob(ctx, c, rest[0], seconds(*timeout, 0, 3600))
	if err != nil {
		return nil, err
	}
	return map[string]any{"job": final, "wait_timed_out": timedOut}, nil
}

func cmdJobsCancel(ctx context.Context, a *App, args []string) (any, error) {
	rest, err := parse(newFlags("jobs cancel"), args, 1)
	if err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodPost, "/v1/jobs/"+jobID(rest)+"/cancel", nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}
