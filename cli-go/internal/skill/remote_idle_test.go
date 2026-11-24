package skill

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/netidle"
)

func TestArchiveDownloadThatKeepsMovingFinishesAndAStallFails(t *testing.T) {
	old := remoteArchiveIdle
	remoteArchiveIdle = 300 * time.Millisecond
	t.Cleanup(func() { remoteArchiveIdle = old })
	stall := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i, b := range []byte("ARCHIVE-BYTES") {
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

	body, err := httpGetArchive(context.Background(), srv.Client(), srv.URL)
	if err != nil || string(body) != "ARCHIVE-BYTES" {
		t.Fatalf("slow archive = %q, %v", body, err)
	}
	stall = true
	if _, err := httpGetArchive(context.Background(), srv.Client(), srv.URL); !errors.Is(err, netidle.ErrStalled) {
		t.Fatalf("stalled archive = %v", err)
	}
}
