package netidle

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestProgressRacingTheTimerNeverCancels(t *testing.T) {
	moving := Start(context.Background(), &http.Client{}, 100*time.Millisecond, false)
	for end := time.Now().Add(600 * time.Millisecond); time.Now().Before(end); {
		moving.extend(moving.idle) // progress right around every expiry
		time.Sleep(10 * time.Millisecond)
	}
	if moving.Stalled() || moving.Ctx.Err() != nil {
		t.Fatal("a transfer that kept moving was cancelled")
	}
	moving.Stop()
	if moving.Stalled() {
		t.Fatal("stopping a transfer must not read as a stall")
	}
	moving.extend(time.Hour) // progress after stop is ignored

	idle := Start(context.Background(), nil, 20*time.Millisecond, false)
	defer idle.Stop()
	select {
	case <-idle.Ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("an idle transfer was never cancelled")
	}
	if !idle.Stalled() {
		t.Fatal("an idle transfer must end as stalled")
	}
}
