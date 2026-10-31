package cli

import (
	"context"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func cmdSkillInstall(_ context.Context, a *App, args []string) (any, error) {
	fs := newFlags("skill install")
	host := fs.String("host", "", "claude-code or codex")
	scope := fs.String("scope", "user", "user or project")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if *host != "claude-code" && *host != "codex" {
		return nil, fail("USAGE", "--host must be claude-code or codex")
	}
	result, err := skill.Install(skill.InstallOptions{Host: *host, Scope: *scope, Home: a.Home, CWD: a.CWD})
	if err != nil {
		return nil, fail("INVALID_REQUEST", "%v", err)
	}
	return result, nil
}

func cmdSkillStatus(_ context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("skill status"), args, 0); err != nil {
		return nil, err
	}
	installed, err := skill.Installed(a.Home, a.CWD)
	if err != nil {
		return nil, fail("INTERNAL_ERROR", "%v", err)
	}
	return map[string]any{"bundled_version": skill.BundleVersion, "installed": installed}, nil
}
