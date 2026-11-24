package cli

import (
	"context"
	"time"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/netidle"
)

// defaultTransferIdle ends an upload or download whose connection has moved no bytes for this
// long. Transfers have no total limit: a slow link that keeps moving data finishes.
const defaultTransferIdle = 30 * time.Second

// startTransfer bounds one storage upload or download by idleness (see netidle). API calls
// keep the total timeout of a.HTTP.
func (a *App) startTransfer(ctx context.Context, upload bool) *netidle.Transfer {
	idle := a.TransferIdle
	if idle <= 0 {
		idle = defaultTransferIdle
	}
	return netidle.Start(ctx, a.HTTP, idle, upload)
}

func stalledFailure(t *netidle.Transfer, what string) error {
	return fail("NETWORK_ERROR", "%s stalled: nothing moved for %s; retry", what, t.Window())
}
