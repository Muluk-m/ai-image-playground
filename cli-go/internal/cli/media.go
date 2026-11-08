package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

type media struct {
	MediaID     string `json:"media_id"`
	Status      string `json:"status"`
	Bytes       int64  `json:"bytes"`
	ContentType string `json:"content_type"`
	Width       *int   `json:"width"`
	Height      *int   `json:"height"`
}

var uploadTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
}

// uploadMedia streams a local image to the presigned URL; the file is read twice
// (hash, then upload) instead of being held in memory.
func (a *App) uploadMedia(ctx context.Context, c *client.HTTPClient, path string) (media, error) {
	contentType := uploadTypes[strings.ToLower(filepath.Ext(path))]
	if contentType == "" {
		return media{}, fail("INVALID_REQUEST", "%s: only .png, .jpg, .jpeg and .webp images can be uploaded", filepath.Base(path))
	}
	file, err := os.Open(path)
	if err != nil {
		return media{}, fail("INVALID_REQUEST", "Cannot read %s: %v", path, err)
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return media{}, fail("INVALID_REQUEST", "Cannot read %s: %v", path, err)
	}
	var reserved struct {
		media
		UploadURL string `json:"upload_url"`
	}
	if err := c.Do(ctx, http.MethodPost, "/v1/media", map[string]any{
		"sha256": hex.EncodeToString(hash.Sum(nil)), "bytes": size, "content_type": contentType,
	}, &reserved); err != nil {
		return media{}, err
	}
	if reserved.UploadURL == "" {
		return reserved.media, nil // the same image was uploaded before
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return media{}, err
	}
	if err := a.checkStorageURL(reserved.UploadURL); err != nil {
		return media{}, err
	}
	a.progress("Uploading %s (%d bytes)", filepath.Base(path), size)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reserved.UploadURL, file)
	if err != nil {
		return media{}, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return media{}, fail("NETWORK_ERROR", "Upload failed: could not reach storage")
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return media{}, fail("TEMPORARILY_UNAVAILABLE", "Upload failed with HTTP %d", resp.StatusCode)
	}
	var completed media
	if err := c.Do(ctx, http.MethodPost, "/v1/media/"+url.PathEscape(reserved.MediaID)+"/complete", nil, &completed); err != nil {
		return media{}, err
	}
	return completed, nil
}

func cmdMediaUpload(ctx context.Context, a *App, args []string) (any, error) {
	rest, err := parse(newFlags("media upload"), args, 1)
	if err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	return a.uploadMedia(ctx, c, rest[0])
}

func cmdMediaList(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("media list")
	limit := fs.Int("limit", 20, "Images per page, 1-100")
	cursor := fs.String("cursor", "", "Continue from the previous page's next_cursor")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	query := url.Values{"limit": {strconv.Itoa(*limit)}}
	if *cursor != "" {
		query.Set("cursor", *cursor)
	}
	return a.getJSON(ctx, "/v1/media?"+query.Encode())
}

func cmdMediaGet(ctx context.Context, a *App, args []string) (any, error) {
	rest, err := parse(newFlags("media get"), args, 1)
	if err != nil {
		return nil, err
	}
	return a.getJSON(ctx, "/v1/media/"+url.PathEscape(rest[0]))
}

func cmdArtifactsGet(ctx context.Context, a *App, args []string) (any, error) {
	rest, err := parse(newFlags("artifacts get"), args, 1)
	if err != nil {
		return nil, err
	}
	return a.getJSON(ctx, "/v1/artifacts/"+url.PathEscape(rest[0]))
}

func cmdMediaDownload(ctx context.Context, a *App, args []string) (any, error) {
	return a.downloadCommand(ctx, "media download", "/v1/media/", args)
}

func cmdArtifactsDownload(ctx context.Context, a *App, args []string) (any, error) {
	return a.downloadCommand(ctx, "artifacts download", "/v1/artifacts/", args)
}

func (a *App) getJSON(ctx context.Context, path string) (any, error) {
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	var data json.RawMessage
	if err := c.Do(ctx, http.MethodGet, path, nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func (a *App) downloadCommand(ctx context.Context, name, prefix string, args []string) (any, error) {
	fs := newFlags(name)
	output := fs.String("output", "", "File to create; omitted: ./ID plus the image's extension. Never overwrites")
	rest, err := parse(fs, args, 1)
	if err != nil {
		return nil, err
	}
	c, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	target := *output
	if target == "" {
		target = rest[0]
	}
	return a.downloadTo(ctx, c, prefix+url.PathEscape(rest[0])+"/download", target)
}

type download struct {
	Path        string `json:"path"`
	Bytes       int64  `json:"bytes"`
	ContentType string `json:"content_type"`
	// AlreadyPresent means the target already held these exact bytes (a rerun after an
	// interrupted download); nothing was written.
	AlreadyPresent bool `json:"already_present,omitempty"`
}

// downloadTo fetches a fresh signed URL and writes the file atomically without ever
// replacing an existing file. An existing file with the same bytes counts as downloaded;
// one with other bytes is FILE_EXISTS. A failure here never changes anything on the server.
func (a *App) downloadTo(ctx context.Context, c *client.HTTPClient, path, target string) (download, error) {
	var signed struct {
		DownloadURL string `json:"download_url"`
		ContentType string `json:"content_type"`
	}
	if err := c.Do(ctx, http.MethodGet, path, nil, &signed); err != nil {
		return download{}, err
	}
	if filepath.Ext(target) == "" {
		if exts, _ := mime.ExtensionsByType(signed.ContentType); len(exts) > 0 {
			target += preferredExt(signed.ContentType, exts)
		}
	}
	if err := a.checkStorageURL(signed.DownloadURL); err != nil {
		return download{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, signed.DownloadURL, nil)
	if err != nil {
		return download{}, err
	}
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return download{}, fail("NETWORK_ERROR", "Download failed: could not reach storage")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return download{}, fail("TEMPORARILY_UNAVAILABLE", "Download failed with HTTP %d; retry to get a new link", resp.StatusCode)
	}
	size, present, err := writeNew(target, resp.Body)
	if err != nil {
		return download{}, err
	}
	absolute, _ := filepath.Abs(target)
	return download{Path: absolute, Bytes: size, ContentType: signed.ContentType, AlreadyPresent: present}, nil
}

// checkStorageURL only lets local image bytes (or a download) go over https; a plain
// http URL is accepted only when the API itself is a local development server.
func (a *App) checkStorageURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fail("INVALID_RESPONSE", "The server returned an invalid storage URL")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	api, _ := url.Parse(a.APIURL)
	if parsed.Scheme == "http" && api != nil && api.Scheme == "http" {
		return nil // validateAPIURL only allows http for localhost
	}
	return fail("INVALID_RESPONSE", "Refusing to transfer files over a non-https storage URL")
}

func preferredExt(contentType string, exts []string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/svg+xml":
		return ".svg"
	}
	return exts[0]
}

func fileExists(target string) *Failure {
	return &Failure{Code: "FILE_EXISTS", Message: target + " already exists with other content; choose another --output or --download directory", Details: map[string]string{"path": target}}
}

// sameContent reports whether existing holds exactly the size bytes of fresh. Sizes are
// compared first; equal sizes are compared in chunks, never whole files in memory. An error
// means existing could not be read, which is not the same as holding other bytes;
// os.ErrNotExist means it is gone.
func sameContent(fresh string, size int64, existing string) (bool, error) {
	info, err := os.Stat(existing)
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return false, nil
	}
	left, err := os.Open(fresh)
	if err != nil {
		return false, err
	}
	defer left.Close()
	right, err := os.Open(existing)
	if err != nil {
		return false, err
	}
	defer right.Close()
	a, b := make([]byte, 64<<10), make([]byte, 64<<10)
	for {
		n, errA := io.ReadFull(left, a)
		m, errB := io.ReadFull(right, b)
		if n != m || !bytes.Equal(a[:n], b[:m]) {
			return false, nil
		}
		done := errA == io.EOF || errA == io.ErrUnexpectedEOF
		if done && errB == errA {
			return true, nil
		}
		if done || errB == io.EOF || errB == io.ErrUnexpectedEOF {
			return false, nil
		}
		if errA != nil {
			return false, errA
		}
		if errB != nil {
			return false, errB
		}
	}
}

// existingTarget decides about a target that was in the way: the same bytes are present,
// other bytes are FILE_EXISTS, an unreadable one is a local error. retry reports a target
// that disappeared meanwhile, so placing the file can be tried again.
func existingTarget(fresh string, size int64, target string) (present, retry bool, err error) {
	same, err := sameContent(fresh, size, target)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return false, true, nil
	case err != nil:
		return false, false, fail("INVALID_REQUEST", "Cannot read the existing %s to compare it: %v", target, auth.Reason(err))
	case same:
		return true, false, nil
	}
	return false, false, fileExists(target)
}

// writeNew streams into a temp file beside target, then links it into place. Linking
// fails if target exists, so a concurrent writer is never overwritten. Filesystems
// without hard links fall back to an exclusive create. A target that already holds the
// same bytes is left as it is and reported as present.
func writeNew(target string, body io.Reader) (int64, bool, error) {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, false, fail("INVALID_REQUEST", "Cannot create %s: %v", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".muvloom-download-*")
	if err != nil {
		return 0, false, fail("INVALID_REQUEST", "Cannot write in %s: %v", dir, err)
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, body)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, false, fail("NETWORK_ERROR", "Download interrupted: %v", err)
	}
	// CreateTemp makes the file 0600; a downloaded image is ordinary user content.
	_ = os.Chmod(tmp.Name(), 0o644)
	var linkErr error
	for attempt := 0; attempt < 2; attempt++ {
		if linkErr = os.Link(tmp.Name(), target); linkErr == nil {
			return size, false, nil
		}
		if !errors.Is(linkErr, os.ErrExist) {
			break
		}
		present, retry, err := existingTarget(tmp.Name(), size, target)
		if !retry {
			if err != nil {
				return 0, false, err
			}
			return size, present, nil
		}
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, os.ErrExist) {
		present, _, err := existingTarget(tmp.Name(), size, target)
		if err != nil {
			return 0, false, err
		}
		return size, present, nil
	}
	if err != nil {
		return 0, false, fail("INVALID_REQUEST", "Cannot create %s: %v", target, err)
	}
	src, err := os.Open(tmp.Name())
	if err != nil {
		out.Close()
		os.Remove(target)
		return 0, false, err
	}
	defer src.Close()
	_, copyErr := io.Copy(out, src)
	closeErr := out.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		// A partial file would make the retry fail with FILE_EXISTS.
		os.Remove(target)
		return 0, false, fail("INTERNAL_ERROR", "Cannot write %s: %v", target, err)
	}
	return size, false, nil
}
