package cli

import (
	"context"
	"os"
	"path/filepath"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/updates"
)

func cmdUpdateCheck(ctx context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("update check"), args, 0); err != nil {
		return nil, err
	}
	result := struct {
		updates.Result
		InstallDirectory string `json:"install_directory,omitempty"`
	}{Result: (updates.Checker{Dir: a.Store.Dir, Version: Version, HTTP: a.HTTP}).Check(ctx)}
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		result.InstallDirectory = filepath.Dir(executable)
	}
	return result, nil
}
