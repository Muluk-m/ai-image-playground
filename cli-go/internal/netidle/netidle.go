// Package netidle bounds a file transfer by idleness instead of a total timeout: a slow link
// that keeps moving bytes finishes, a connection on which nothing moves is cancelled.
package netidle

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

// ResponseWaitFactor stretches the idle limit once an upload body is fully written: the kernel
// still has to put its buffered tail on the wire, and the server answers only after that. A
// download sends no body, so it keeps the plain idle limit while waiting for the response.
const ResponseWaitFactor = 4

// progressChunk caps one socket write, so progress is seen while a slow link drains a large
// write instead of only when the whole write returns. The kernel does not portably report how
// much of a blocked write has left, so this is also the minimum rate: a link that cannot send
// progressChunk bytes within the idle limit (about 68 B/s for 30 seconds) counts as stalled.
const progressChunk = 2 << 10

// ErrStalled is the context cause when nothing moved before the deadline.
var ErrStalled = errors.New("transfer stalled")

// Transfer is one upload or download. Send its request with Ctx on Client; progress is any
// byte read from or written to the connection. Call Stop when done.
type Transfer struct {
	Ctx    context.Context
	Client *http.Client

	idle   time.Duration
	cancel context.CancelCauseFunc
	timer  *time.Timer

	mu       sync.Mutex
	window   time.Duration
	deadline time.Time
	stopped  bool
}

// Start begins a transfer on a copy of base without its total timeout, on its own transport.
// upload widens the wait for the response once the request body is written.
func Start(ctx context.Context, base *http.Client, idle time.Duration, upload bool) *Transfer {
	ctx, cancel := context.WithCancelCause(ctx)
	t := &Transfer{idle: idle, cancel: cancel, window: idle, deadline: time.Now().Add(idle)}
	t.Ctx = ctx
	if upload {
		t.Ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				if info.Err == nil {
					t.extend(idle * ResponseWaitFactor)
				}
			},
		})
	}
	t.Client = client(base, t)
	t.timer = time.AfterFunc(idle, t.expire)
	return t
}

// expire runs when the timer fires. Progress may have moved the deadline after the timer was
// already scheduled, so it re-checks under the lock and waits again instead of cancelling.
func (t *Transfer) expire() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped {
		return
	}
	if left := time.Until(t.deadline); left > 0 {
		t.timer.Reset(left)
		return
	}
	t.cancel(ErrStalled)
}

// extend moves the deadline to now plus window, unless the transfer already ended.
func (t *Transfer) extend(window time.Duration) {
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

// Stop ends the transfer; later progress is ignored and it never reads as stalled.
func (t *Transfer) Stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
	t.timer.Stop()
	t.cancel(nil)
	t.Client.CloseIdleConnections()
}

// Stalled reports whether the transfer was cancelled because nothing moved.
func (t *Transfer) Stalled() bool { return errors.Is(context.Cause(t.Ctx), ErrStalled) }

// Window is the idle limit in force, for messages: the plain limit, or the wider wait for a
// response after an upload body.
func (t *Transfer) Window() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.window
}

func client(base *http.Client, t *Transfer) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	c := *base
	c.Timeout = 0
	if base.Transport == nil {
		c.Transport = connTransport(http.DefaultTransport.(*http.Transport), t)
	} else if transport, ok := base.Transport.(*http.Transport); ok {
		c.Transport = connTransport(transport, t)
	} else {
		// A custom RoundTripper (a test stub, a proxy wrapper) is kept as it is; only the response
		// body's reads count as progress there.
		c.Transport = bodyTransport{next: base.Transport, t: t}
	}
	return &c
}

func connTransport(transport *http.Transport, t *Transfer) *http.Transport {
	tr := transport.Clone()
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
	return tr
}

type bodyTransport struct {
	next http.RoundTripper
	t    *Transfer
}

func (b bodyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := b.next.RoundTrip(req)
	if err == nil {
		b.t.extend(b.t.idle)
		resp.Body = progressBody{ReadCloser: resp.Body, t: b.t}
	}
	return resp, err
}

type progressBody struct {
	io.ReadCloser
	t *Transfer
}

func (p progressBody) Read(b []byte) (int, error) {
	n, err := p.ReadCloser.Read(b)
	if n > 0 {
		p.t.extend(p.t.idle)
	}
	return n, err
}

type progressConn struct {
	net.Conn
	t *Transfer
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
