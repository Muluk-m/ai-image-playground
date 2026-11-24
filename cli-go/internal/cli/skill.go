package cli

import (
	"context"
	"strings"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func cmdSkillInstall(_ context.Context, a *App, args []string) (any, error) {
	fs := newFlags("skill install")
	supported := strings.Join(skill.SupportedHosts(), ", ")
	host := fs.String("host", "", "Agent host: auto, "+supported+", or generic")
	scope := fs.String("scope", "user", "user (every project) or project (this directory); ignored for generic")
	output := fs.String("output", "", "For --host generic, directory that will receive muvloom/ (default: current directory)")
	dir := fs.String("dir", "", "A host's skills directory that will receive muvloom/; recorded so status and updates find it")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if *dir != "" {
		if *host != "" || *output != "" {
			return nil, fail("USAGE", "--dir cannot be combined with --host or --output")
		}
		result, err := skill.Install(skill.InstallOptions{Dir: *dir, Home: a.Home, CWD: a.CWD})
		if err != nil {
			return nil, fail("INVALID_REQUEST", "%v", err)
		}
		return result, nil
	}
	if *host != "auto" && *host != "generic" && !skill.IsSupportedHost(*host) {
		return nil, fail("USAGE", "--host must be auto, %s, or generic", supported)
	}
	if *host != "generic" && *output != "" {
		return nil, fail("USAGE", "--output is only used with --host generic")
	}
	opts := skill.InstallOptions{Host: *host, Scope: *scope, Output: *output, Home: a.Home, CWD: a.CWD}
	if *host == "auto" {
		result, err := skill.InstallAuto(opts, a.Getenv)
		if err != nil {
			return nil, fail("INVALID_REQUEST", "%v", err)
		}
		for _, f := range result.Failed {
			a.progress("Could not install the muvloom Skill for %s (%s)", f.Host, f.Reason)
		}
		return result, nil
	}
	result, err := skill.Install(opts)
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
	return map[string]any{"bundled_version": skill.SkillVersion, "installed": installed}, nil
}

// cmdSkillShow prints the bundled Skill for hosts that cannot install one: the agent reads
// it at the start of a session instead.
func cmdSkillShow(_ context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("skill show"), args, 0); err != nil {
		return nil, err
	}
	content, err := skill.Content()
	if err != nil {
		return nil, fail("INTERNAL_ERROR", "%v", err)
	}
	// Text output is the content verbatim (see writeText), so it can be piped into a prompt.
	return map[string]any{"version": skill.SkillVersion, "content": content}, nil
}
