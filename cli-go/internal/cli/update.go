package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/updates"
)

func cmdUpdateCheck(ctx context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("update check"), args, 0); err != nil {
		return nil, err
	}
	result := struct {
		updates.Result
		InstallDirectory string `json:"install_directory,omitempty"`
		SkillAutoUpdate  bool   `json:"skill_auto_update"`
	}{
		Result:          (updates.Checker{Dir: a.Store.Dir, Version: Version, HTTP: a.HTTP}).Check(ctx),
		SkillAutoUpdate: skill.AutoUpdateEnabled(a.Store.Dir),
	}
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		result.InstallDirectory = filepath.Dir(executable)
	}
	return result, nil
}

func cmdUpdateSkill(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("update skill")
	checkOnly := fs.Bool("check", false, "Check for newer Skills without modifying local files")
	autoMode := fs.String("auto", "", "Enable or disable automatic background Skill updates (on|off)")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	mode := strings.ToLower(strings.TrimSpace(*autoMode))
	if *checkOnly && mode != "" {
		return nil, fail("USAGE", "use either --check or --auto, not both")
	}
	if mode != "" {
		var enabled bool
		switch mode {
		case "on":
			enabled = true
		case "off":
			enabled = false
		default:
			return nil, fail("USAGE", "--auto must be \"on\" or \"off\"")
		}
		if err := skill.SetAutoUpdate(a.Store.Dir, enabled); err != nil {
			return nil, fail("INTERNAL_ERROR", "Could not save automatic Skill update preference")
		}
		return map[string]any{"auto_update": enabled}, nil
	}

	apiURL := a.APIURL
	if a.apiURLSource == sourceDefault || a.apiURLSource == "" {
		if svc, err := a.Store.LoadService(); err == nil && svc != "" {
			apiURL = svc
		}
	}
	res, err := skill.CheckOrUpdateRemote(ctx, skill.RemoteUpdateOptions{
		Home:     a.Home,
		CWD:      a.CWD,
		StateDir: a.Store.Dir,
		APIURL:   apiURL,
		BaseURL:  a.ManifestBaseURL,
		HTTP:     a.HTTP,
	}, *checkOnly)
	if err != nil {
		return nil, fail("TEMPORARILY_UNAVAILABLE", "Could not update Muvloom Skills: %s", err.Error())
	}
	return res, nil
}
