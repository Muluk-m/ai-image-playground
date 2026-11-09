package cli

import (
	"context"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/client"
)

// defaultTransferIdleTimeout bounds how long a file transfer may move no bytes at all,
// instead of how long the whole transfer may take. A 4K result or a large reference image
// on a slow link legitimately takes minutes, so a total timeout can only be wrong: too
// short cuts off a healthy transfer, too long leaves a dead one hanging. Storage delivers
// or accepts bytes continuously, so complete silence is the signal that something is
// broken. The threshold equals the total timeout ordinary API requests still use: a stall
// is never reported sooner than the CLI already gave up today, while progress is never
// punished. Also covers the wait for the response after an upload body was sent.
const defaultTransferIdleTimeout = 60 * time.Second

// transferGuard watches one file transfer and cancels it once it stops making progress.
// Every chunk that moves through the reader it wraps counts as progress.
type transferGuard struct {
	idle   time.Duration
	last   atomic.Int64 // UnixNano when bytes last moved
	fired  atomic.Bool  // the guard, not the caller, canceled the transfer
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

// newTransfer derives a cancelable context for a file transfer and starts its guard. The
// caller must always call stop, which releases both the goroutine and the context.
func (a *App) newTransfer(ctx context.Context) (context.Context, *transferGuard) {
	idle := a.TransferIdleTimeout
	if idle <= 0 {
		idle = defaultTransferIdleTimeout
	}
	ctx, cancel := context.WithCancel(ctx)
	g := &transferGuard{idle: idle, cancel: cancel, done: make(chan struct{})}
	g.mark()
	go g.watch()
	return ctx, g
}

// transferHTTP is a.HTTP without its total timeout: a transfer is bounded by its guard, so
// one that keeps making progress is never cut off however long it takes. Redirects stay
// refused, since one could send signed bytes to a host nobody chose.
func (a *App) transferHTTP() *http.Client {
	base := a.HTTP
	if base == nil {
		base = &http.Client{}
	}
	copied := *base
	copied.Timeout = 0
	copied.CheckRedirect = client.NoRedirects
	return &copied
}

func (g *transferGuard) mark() { g.last.Store(time.Now().UnixNano()) }

// watch cancels the transfer as soon as no byte has moved for the idle threshold. It polls
// instead of resetting a timer per chunk, so a fast transfer pays only an atomic store.
func (g *transferGuard) watch() {
	step := min(max(g.idle/4, time.Millisecond), time.Second)
	ticker := time.NewTicker(step)
	defer ticker.Stop()
	for {
		select {
		case <-g.done:
			return
		case now := <-ticker.C:
			if now.Sub(time.Unix(0, g.last.Load())) >= g.idle {
				g.fired.Store(true)
				g.cancel()
				return
			}
		}
	}
}

func (g *transferGuard) stop() {
	g.once.Do(func() { close(g.done) })
	g.cancel()
}

// reader counts everything read through it as progress. For a download that is the
// response body; for an upload it is the request body, which the transport reads only as
// fast as the connection accepts it.
func (g *transferGuard) reader(r io.Reader) io.Reader {
	return &progressReader{guard: g, inner: r}
}

// body is reader for a response body: it also releases the guard the moment the stream
// ends, so the local work that follows a finished download (comparing a file that is
// already at the target) can never be mistaken for a stalled transfer.
func (g *transferGuard) body(r io.Reader) io.Reader {
	return &progressReader{guard: g, inner: r, stopAtEnd: true}
}

type progressReader struct {
	guard     *transferGuard
	inner     io.Reader
	stopAtEnd bool
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.inner.Read(b)
	if n > 0 {
		p.guard.mark()
	}
	if err != nil && p.stopAtEnd {
		p.guard.stop()
	}
	return n, err
}

// stalled explains a transfer this guard gave up on, and is nil when the transfer failed
// for any other reason (including a caller that canceled it). The code is temporary:
// running the command again is the right answer, and downloads never left a file behind.
func (g *transferGuard) stalled(what string) *Failure {
	if !g.fired.Load() {
		return nil
	}
	return fail("NETWORK_ERROR", "%s stalled: no data for %s; run the command again", what, g.idle)
}
