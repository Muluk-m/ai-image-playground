package cli

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// defaultTransferIdle ends an upload or download that has moved no bytes for this long.
// Transfers have no total limit: a slow link that keeps moving data finishes.
const defaultTransferIdle = 30 * time.Second

// responseWaitFactor stretches the idle limit once an upload body has been fully read.
const responseWaitFactor = 4

var errTransferStalled = errors.New("transfer stalled")

// transfer bounds one upload or download by idleness instead of a total timeout. Wrap the
// bytes that move with track; the context is cancelled once none have moved for the idle
// limit, and stalled reports whether that is why it ended. Call stop when done.
type transfer struct {
	ctx   context.Context
	idle  time.Duration
	timer *time.Timer
	stop  func()
}

func (a *App) startTransfer(ctx context.Context) *transfer {
	idle := a.TransferIdle
	if idle <= 0 {
		idle = defaultTransferIdle
	}
	ctx, cancel := context.WithCancelCause(ctx)
	timer := time.AfterFunc(idle, func() { cancel(errTransferStalled) })
	return &transfer{ctx: ctx, idle: idle, timer: timer, stop: func() {
		timer.Stop()
		cancel(nil)
	}}
}

func (t *transfer) track(r io.Reader) io.Reader { return &progressReader{r: r, t: t} }

func (t *transfer) stalled() bool { return errors.Is(context.Cause(t.ctx), errTransferStalled) }

func (t *transfer) stalledFailure(what string) error {
	return fail("NETWORK_ERROR", "%s stalled: no data moved for %s; retry", what, t.idle)
}

type progressReader struct {
	r io.Reader
	t *transfer
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	switch {
	case err == io.EOF:
		// An upload body is fully handed to the kernel long before it is on the wire, and the
		// storage answers only after receiving it all: allow longer for that last stretch.
		p.t.timer.Reset(p.t.idle * responseWaitFactor)
	case n > 0:
		p.t.timer.Reset(p.t.idle)
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
