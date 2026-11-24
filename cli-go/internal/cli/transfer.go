package cli

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

// defaultTransferIdle ends an upload or download that has moved no bytes for this long.
// Transfers have no total limit: a slow link that keeps moving data finishes.
const defaultTransferIdle = 30 * time.Second

// responseWaitFactor stretches the idle limit once an upload body has been fully read: the
// kernel still has to put the buffered tail on the wire, and storage answers only after that.
const responseWaitFactor = 4

var errTransferStalled = errors.New("transfer stalled")

// transfer bounds one upload or download by idleness instead of a total timeout. Wrap the
// bytes that move with track; the context is cancelled once none have moved for the current
// window, and stalled reports whether that is why it ended. Call stop when done.
type transfer struct {
	ctx    context.Context
	idle   time.Duration
	cancel context.CancelCauseFunc
	timer  *time.Timer

	mu      sync.Mutex
	window  time.Duration
	stopped bool
}

func (a *App) startTransfer(ctx context.Context) *transfer {
	idle := a.TransferIdle
	if idle <= 0 {
		idle = defaultTransferIdle
	}
	ctx, cancel := context.WithCancelCause(ctx)
	t := &transfer{ctx: ctx, idle: idle, cancel: cancel, window: idle}
	t.timer = time.AfterFunc(idle, func() { cancel(errTransferStalled) })
	return t
}

func (t *transfer) stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
	t.timer.Stop()
	t.cancel(nil)
}

// extend restarts the idle clock with the given window, unless the transfer already ended.
func (t *transfer) extend(window time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return
	}
	t.window = window
	t.timer.Reset(window)
}

func (t *transfer) track(r io.Reader) io.Reader { return &progressReader{r: r, t: t} }

func (t *transfer) stalled() bool { return errors.Is(context.Cause(t.ctx), errTransferStalled) }

func (t *transfer) stalledFailure(what string) error {
	t.mu.Lock()
	window := t.window
	t.mu.Unlock()
	return fail("NETWORK_ERROR", "%s stalled: nothing moved for %s; retry", what, window)
}

type progressReader struct {
	r io.Reader
	t *transfer
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	switch {
	case err == io.EOF:
		p.t.extend(p.t.idle * responseWaitFactor)
	case n > 0:
		p.t.extend(p.t.idle)
	}
	return n, err
}

// transferClient is the API client without its total timeout; transfers are bounded by
// idleness instead (see startTransfer).
func (a *App) transferClient() *http.Client {
	c := *a.HTTP
	c.Timeout = 0
	return &c
}
