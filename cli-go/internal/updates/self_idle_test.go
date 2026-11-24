package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/netidle"
)

func TestBinaryDownloadThatKeepsMovingFinishesAndAStallFails(t *testing.T) {
	old := selfBinaryIdle
	selfBinaryIdle = 300 * time.Millisecond
	t.Cleanup(func() { selfBinaryIdle = old })
	payload := []byte(strings.Repeat("B", 12))
	sum := sha256.Sum256(payload)
	stall := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i, b := range payload {
			if stall && i == 3 {
				<-r.Context().Done()
				return
			}
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
			time.Sleep(80 * time.Millisecond) // ~1s in total, three times the idle limit
		}
	}))
	t.Cleanup(srv.Close)

	data, err := downloadVerifiedBinary(context.Background(), srv.Client(), srv.URL, len(payload), hex.EncodeToString(sum[:]))
	if err != nil || string(data) != string(payload) {
		t.Fatalf("slow download = %q, %v", data, err)
	}
	stall = true
	_, err = downloadVerifiedBinary(context.Background(), srv.Client(), srv.URL, len(payload), hex.EncodeToString(sum[:]))
	if !errors.Is(err, ErrSelfRemoteUnavailable) || !errors.Is(err, netidle.ErrStalled) {
		t.Fatalf("stalled download = %v", err)
	}
}
