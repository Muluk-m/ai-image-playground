package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
	"github.com/Muluk-m/ai-image-playground/cli-go/internal/updates"
)

func (a *App) effectiveUpdateAPIURL() string {
	apiURL := a.APIURL
	// Only inherit connection.json when no explicit MUVLOOM_API_URL was provided.
	if a.apiURLSource == sourceDefault {
		if svc, err := a.Store.LoadService(); err == nil && svc != "" {
			apiURL = svc
		}
	}
	return apiURL
}

func cmdUpdateCheck(ctx context.Context, a *App, args []string) (any, error) {
	if _, err := parse(newFlags("update check"), args, 0); err != nil {
		return nil, err
	}
	origin, _ := skill.ResolveManifestOrigin(a.effectiveUpdateAPIURL(), a.ManifestBaseURL)
	result := struct {
		updates.Result
		InstallDirectory string `json:"install_directory,omitempty"`
		CLIAutoUpdate    bool   `json:"cli_auto_update"`
		SkillAutoUpdate  bool   `json:"skill_auto_update"`
	}{
		Result:          (updates.Checker{Dir: a.Store.Dir, Version: Version, ManifestOrigin: origin, HTTP: a.HTTP}).Check(ctx),
		CLIAutoUpdate:   updates.SelfAutoUpdateEnabled(a.Store.Dir),
		SkillAutoUpdate: skill.AutoUpdateEnabled(a.Store.Dir),
	}
	exe := strings.TrimSpace(a.ExecutablePath)
	if exe == "" {
		if found, err := os.Executable(); err == nil {
			exe = found
		}
	}
	if exe != "" {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		result.InstallDirectory = filepath.Dir(exe)
	}
	return result, nil
}

func cmdUpdateSelf(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("update self")
	checkOnly := fs.Bool("check", false, "Check for a newer CLI binary without modifying disk")
	autoMode := fs.String("auto", "", "Enable or disable automatic background CLI self-updates (on|off)")
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
		if err := updates.SetSelfAutoUpdate(a.Store.Dir, enabled); err != nil {
			return nil, fail("INTERNAL_ERROR", "Could not save automatic CLI self-update preference")
		}
		return map[string]any{"auto_update": enabled}, nil
	}

	res, err := updates.CheckOrUpdateSelf(ctx, updates.SelfUpdateOptions{
		StateDir:       a.Store.Dir,
		CurrentVersion: Version,
		ExecutablePath: a.ExecutablePath,
		APIURL:         a.effectiveUpdateAPIURL(),
		BaseURL:        a.ManifestBaseURL,
		HTTP:           a.HTTP,
	}, *checkOnly)
	if err != nil {
		return nil, classifySelfUpdateError(err)
	}
	return res, nil
}

func classifySelfUpdateError(err error) *Failure {
	switch {
	case errors.Is(err, updates.ErrSelfUnsupportedService):
		return fail("CAPABILITY_UNAVAILABLE", "Automatic CLI self-updates are only available for official Muvloom services")
	case errors.Is(err, updates.ErrSelfUnsupportedPlatform):
		return fail("CAPABILITY_UNAVAILABLE", "No prebuilt muvloom CLI binary is available for this OS/architecture")
	case errors.Is(err, updates.ErrSelfUpdateBusy):
		return fail("TEMPORARILY_UNAVAILABLE", "Another muvloom process is updating the CLI binary; retry shortly")
	case errors.Is(err, updates.ErrSelfRemoteUnavailable):
		return fail("NETWORK_ERROR", "Could not reach Muvloom to download the CLI update; retry shortly")
	case errors.Is(err, updates.ErrSelfInvalidBinary):
		return fail("INTERNAL_ERROR", "Could not verify the Muvloom CLI binary checksum")
	case errors.Is(err, os.ErrPermission):
		return fail("INTERNAL_ERROR", "Could not replace the muvloom CLI binary (permission denied)")
	default:
		return fail("INTERNAL_ERROR", "Could not update the muvloom CLI binary (%s)", updates.SelfErrorReason(err))
	}
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

	res, err := skill.CheckOrUpdateRemote(ctx, skill.RemoteUpdateOptions{
		Home:     a.Home,
		CWD:      a.CWD,
		StateDir: a.Store.Dir,
		APIURL:   a.effectiveUpdateAPIURL(),
		BaseURL:  a.ManifestBaseURL,
		HTTP:     a.HTTP,
	}, *checkOnly)
	if err != nil {
		return nil, classifyRemoteSkillError(err)
	}
	for _, failed := range res.Failed {
		a.progress("Could not update the muvloom Skill at %s (%s).", failed.Path, failed.Reason)
	}
	return res, nil
}

func classifyRemoteSkillError(err error) *Failure {
	switch {
	case errors.Is(err, skill.ErrUnsupportedService):
		return fail("CAPABILITY_UNAVAILABLE", "Automatic Skill updates are only available for official Muvloom services")
	case errors.Is(err, skill.ErrUpdateBusy):
		return fail("TEMPORARILY_UNAVAILABLE", "Another muvloom process is updating Skills; retry shortly")
	case errors.Is(err, skill.ErrRemoteUnavailable):
		return fail("NETWORK_ERROR", "Could not reach Muvloom to check for Skill updates; retry shortly")
	case errors.Is(err, skill.ErrInvalidManifest):
		return fail("INTERNAL_ERROR", "Could not verify the Muvloom Skill update package")
	case errors.Is(err, os.ErrPermission):
		return fail("INTERNAL_ERROR", "Could not update Muvloom Skills (permission denied)")
	default:
		return fail("INTERNAL_ERROR", "Could not update Muvloom Skills (%s)", skill.RemoteErrorReason(err))
	}
}
