package cli

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

// defaultTransferIdle ends an upload or download whose connection has moved no bytes for this
// long. Transfers have no total limit: a slow link that keeps moving data finishes.
const defaultTransferIdle = 30 * time.Second

// responseWaitFactor stretches the idle limit once an upload body is fully written: the kernel
// still has to put its buffered tail on the wire, and storage answers only after that. A
// download sends no body, so it keeps the plain idle limit while waiting for the response.
const responseWaitFactor = 4

// progressChunk caps one socket write, so progress is seen while a slow link drains a large
// write instead of only when the whole write returns. The kernel does not portably report how
// much of a blocked write has left, so this is also the minimum rate: a link that cannot send
// progressChunk bytes within the idle limit (about 68 B/s at the defaults) counts as stalled.
const progressChunk = 2 << 10

var errTransferStalled = errors.New("transfer stalled")

// transfer bounds one upload or download by idleness instead of a total timeout. Progress is
// any byte read from or written to the connection (see client); the context is cancelled once
// none has moved before the deadline, and stalled reports whether that is why it ended.
type transfer struct {
	ctx    context.Context
	idle   time.Duration
	cancel context.CancelCauseFunc
	timer  *time.Timer
	http   *http.Client

	mu       sync.Mutex
	window   time.Duration
	deadline time.Time
	stopped  bool
}

func (a *App) startTransfer(ctx context.Context, upload bool) *transfer {
	idle := a.TransferIdle
	if idle <= 0 {
		idle = defaultTransferIdle
	}
	ctx, cancel := context.WithCancelCause(ctx)
	t := &transfer{idle: idle, cancel: cancel, window: idle, deadline: time.Now().Add(idle)}
	t.ctx = ctx
	if upload {
		t.ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				if info.Err == nil {
					t.extend(idle * responseWaitFactor)
				}
			},
		})
	}
	t.http = a.transferClient(t)
	t.timer = time.AfterFunc(idle, t.expire)
	return t
}

// expire runs when the timer fires. Progress may have moved the deadline after the timer was
// already scheduled, so it re-checks under the lock and waits again instead of cancelling.
func (t *transfer) expire() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return
	}
	if left := time.Until(t.deadline); left > 0 {
		t.timer.Reset(left)
		return
	}
	t.cancel(errTransferStalled)
}

// extend moves the deadline to now plus window, unless the transfer already ended.
func (t *transfer) extend(window time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return
	}
	shorter := window < t.window
	t.window = window
	t.deadline = time.Now().Add(window)
	if shorter {
		t.timer.Reset(window) // the pending timer would fire too late; expire re-checks anyway
	}
}

func (t *transfer) stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
	t.timer.Stop()
	t.cancel(nil)
	t.http.CloseIdleConnections()
}

func (t *transfer) stalled() bool { return errors.Is(context.Cause(t.ctx), errTransferStalled) }

func (t *transfer) stalledFailure(what string) error {
	t.mu.Lock()
	window := t.window
	t.mu.Unlock()
	return fail("NETWORK_ERROR", "%s stalled: nothing moved for %s; retry", what, window)
}

// transferClient is the API client without its total timeout and on its own transport, whose
// connections report every byte they move to t.
func (a *App) transferClient(t *transfer) *http.Client {
	base, _ := a.HTTP.Transport.(*http.Transport)
	if base == nil {
		base = http.DefaultTransport.(*http.Transport)
	}
	tr := base.Clone()
	dial := tr.DialContext
	if dial == nil {
		dial = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &progressConn{Conn: conn, t: t}, nil
	}
	if dialTLS := tr.DialTLSContext; dialTLS != nil {
		tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialTLS(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return &progressConn{Conn: conn, t: t}, nil
		}
	}
	c := *a.HTTP
	c.Timeout = 0
	c.Transport = tr
	return &c
}

type progressConn struct {
	net.Conn
	t *transfer
}

func (c *progressConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.t.extend(c.t.idle)
	}
	return n, err
}

func (c *progressConn) Write(b []byte) (int, error) {
	written := 0
	for written < len(b) {
		end := min(written+progressChunk, len(b))
		n, err := c.Conn.Write(b[written:end])
		written += n
		if n > 0 {
			c.t.extend(c.t.idle)
		}
		if err != nil {
			return written, err
		}
	}
	return written, nil
}
