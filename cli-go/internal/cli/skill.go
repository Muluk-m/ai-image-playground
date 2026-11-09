package cli

import (
	"context"
	"flag"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func cmdSkillInstall(_ context.Context, a *App, args []string) (any, error) {
	fs := newFlags("skill install")
	host := fs.String("host", "", "Agent host: claude-code or codex")
	scope := fs.String("scope", "user", "user (every project) or project (this directory)")
	dir := fs.String("dir", "", "Install into this skills directory instead of a known host's; the Skill lands in <dir>/muvloom")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	opts := skill.InstallOptions{Home: a.Home, CWD: a.CWD, ConfigDir: a.configDir()}
	switch {
	case *dir != "":
		if *host != "" || wasSet(fs, "scope") {
			return nil, fail("USAGE", "--dir names the skills directory itself; do not pass --host or --scope with it")
		}
		opts.Dir = *dir
	case *host != "claude-code" && *host != "codex":
		return nil, fail("USAGE", "--host must be claude-code or codex, or use --dir to name a skills directory")
	default:
		opts.Host, opts.Scope = *host, *scope
	}
	result, err := skill.Install(opts)
	if err != nil {
		return nil, fail("INVALID_REQUEST", "%v", err)
	}
	return result, nil
}

// wasSet reports a flag the command line actually carried, so a default is not mistaken for
// a choice the user made.
func wasSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

func cmdSkillStatus(_ context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("skill status"), args, 0); err != nil {
		return nil, err
	}
	installed, err := skill.Installed(a.Home, a.CWD, a.configDir())
	if err != nil {
		return nil, fail("INTERNAL_ERROR", "%v", err)
	}
	return map[string]any{"bundled_version": skill.BundleVersion, "installed": installed}, nil
}

// skillFile is one bundled Skill file. In text mode writeText prints Content alone, byte for
// byte, so a host that cannot install the Skill can read it from stdout.
type skillFile struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Content string `json:"content"`
}

func cmdSkillPrint(_ context.Context, a *App, args []string) (any, error) {
	fs := newFlags("skill print")
	file := fs.String("file", skill.BodyFile, "Which bundled file to print, as listed by --list")
	list := fs.Bool("list", false, "List the bundled files instead of printing one")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if *list {
		files, err := skill.Files()
		if err != nil {
			return nil, fail("INTERNAL_ERROR", "%v", err)
		}
		return map[string]any{"version": skill.BundleVersion, "files": files}, nil
	}
	content, err := skill.Body(*file)
	if err != nil {
		return nil, fail("USAGE", "%v; run `muvloom skill print --list` for the files", err)
	}
	return skillFile{Path: *file, Version: skill.BundleVersion, Content: string(content)}, nil
}
