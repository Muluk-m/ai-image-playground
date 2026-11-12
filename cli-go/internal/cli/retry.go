package cli

import (
	"context"
	"time"
)

// readonlyRetryWait is the pause before the single internal retry of a read-only
// command. Tests set it to zero so the suite stays fast. Do not use this for
// auth login or any command that can open a new approval page.
var readonlyRetryWait = time.Second

func transientCode(code string) bool {
	switch code {
	case "NETWORK_ERROR", "RATE_LIMITED", "TEMPORARILY_UNAVAILABLE":
		return true
	default:
		return false
	}
}

// retryReadonly runs fn and, on a transient service or network error, waits
// briefly and runs it once more. A persistent failure is returned as-is; a
// cancelled context returns the original error so a timeout is not hidden.
func retryReadonly(ctx context.Context, fn func() error) error {
	err := fn()
	if err == nil || !transientCode(asFailure(err).Code) {
		return err
	}
	if readonlyRetryWait > 0 {
		timer := time.NewTimer(readonlyRetryWait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return err
		case <-timer.C:
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return fn()
}
