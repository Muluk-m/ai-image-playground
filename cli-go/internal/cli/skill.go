package cli

import (
	"context"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func cmdSkillInstall(_ context.Context, a *App, args []string) (any, error) {
	fs := newFlags("skill install")
	host := fs.String("host", "", "Agent host: claude-code, codex, or generic")
	scope := fs.String("scope", "user", "user (every project) or project (this directory); ignored for generic")
	output := fs.String("output", "", "For --host generic, directory that will receive muvloom/ (default: current directory)")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if *host != "claude-code" && *host != "codex" && *host != "generic" {
		return nil, fail("USAGE", "--host must be claude-code, codex, or generic")
	}
	if *host != "generic" && *output != "" {
		return nil, fail("USAGE", "--output is only used with --host generic")
	}
	result, err := skill.Install(skill.InstallOptions{Host: *host, Scope: *scope, Output: *output, Home: a.Home, CWD: a.CWD})
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
