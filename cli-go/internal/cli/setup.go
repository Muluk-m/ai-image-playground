package cli

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/skill"
)

func (a *App) getenv(key string) string {
	if a.Getenv != nil {
		return a.Getenv(key)
	}
	return os.Getenv(key)
}

// cmdSetup runs one-shot onboarding: resolves `--origin` to its official API URL, installs
// or refreshes the Skill into the active host(s), checks/completes browser login, fetches live
// `capabilities`, and runs a zero-cost `images validate` smoke quote.
func cmdSetup(ctx context.Context, a *App, args []string) (any, error) {
	fs := newFlags("setup")
	supported := strings.Join(skill.SupportedHosts(), ", ")
	origin := fs.String("origin", "", "Muvloom web origin or API URL (e.g. https://muvloom.online)")
	host := fs.String("host", "auto", "Agent host: auto, "+supported+", generic, or none")
	scope := fs.String("scope", "user", "user (every project) or project (this directory); ignored for generic/none")
	output := fs.String("output", "", "For --host generic, directory that will receive muvloom/ (default: current directory)")
	noWait := fs.Bool("no-wait", false, "Print the approval link and return without waiting (no browser)")
	timeout := fs.Int("timeout", -1, "Seconds to wait for approval; omitted: as long as the code is valid")
	switchService := fs.Bool("switch-service", false, "Sign in to the chosen service although this machine is signed in to another service")
	if _, err := parse(fs, args, 0); err != nil {
		return nil, err
	}

	if *host != "auto" && *host != "none" && *host != "generic" && !skill.IsSupportedHost(*host) {
		return nil, fail("USAGE", "--host must be auto, %s, generic, or none", supported)
	}
	if *host != "generic" && *output != "" {
		return nil, fail("USAGE", "--output is only used with --host generic")
	}
	if *host != "none" && *host != "generic" && *scope != "user" && *scope != "project" {
		return nil, fail("USAGE", "--scope must be \"user\" or \"project\"")
	}

	rawOrigin := strings.TrimSpace(*origin)
	if rawOrigin == "" && a.apiURLSource != sourceEnvironment {
		rawOrigin = strings.TrimSpace(a.getenv("MUVLOOM_ORIGIN"))
	}
	if rawOrigin != "" {
		mappedAPI, ok := skill.APIURLForOrigin(rawOrigin)
		if !ok {
			return nil, fail("USAGE", "unsupported --origin %q; pass an official Muvloom URL (e.g. https://muvloom.online) or set MUVLOOM_API_URL", rawOrigin)
		}
		a.APIURL = mappedAPI
		a.apiURLSource = sourceEnvironment
	}

	// 1. Install or refresh the bundled Skill (unless --host none).
	var installedSkills []skill.Result
	switch *host {
	case "none":
		installedSkills = []skill.Result{}
	case "auto":
		autoRes, err := skill.InstallAuto(skill.InstallOptions{
			Scope: *scope,
			Home:  a.Home,
			CWD:   a.CWD,
		}, a.Getenv)
		if err != nil {
			return nil, fail("INVALID_REQUEST", "%v", err)
		}
		installedSkills = autoRes.Installed
	default:
		res, err := skill.Install(skill.InstallOptions{
			Host:   *host,
			Scope:  *scope,
			Output: *output,
			Home:   a.Home,
			CWD:    a.CWD,
		})
		if err != nil {
			return nil, fail("INVALID_REQUEST", "%v", err)
		}
		installedSkills = []skill.Result{res}
	}

	// 2. Check current account connection (also auto-collects approved pending logins and runs
	// 24h silent CLI/Skill updates).
	statusAny, err := cmdAuthStatus(ctx, a, nil)
	if err != nil {
		return nil, err
	}
	statusMap, _ := statusAny.(map[string]any)
	state, _ := statusMap["state"].(string)

	switch state {
	case "ready":
		// Already signed in and meets min_cli_version.
	case "outdated":
		return nil, fail("UPGRADE_REQUIRED", "This CLI (%v) is older than the server minimum (%v); run `muvloom update self`", statusMap["cli_version"], statusMap["min_cli_version"])
	case "unreachable":
		if errMap, ok := statusMap["error"].(map[string]string); ok && errMap["code"] != "" {
			return nil, fail(errMap["code"], "%s", errMap["message"])
		}
		return nil, fail("TEMPORARILY_UNAVAILABLE", "Could not reach %s; retry shortly", a.APIURL)
	case "service_mismatch":
		if !*switchService {
			connURL, _ := statusMap["connection_api_url"].(string)
			return nil, a.serviceMismatch(connURL)
		}
		fallthrough
	default:
		var loginArgs []string
		if *noWait {
			loginArgs = append(loginArgs, "--no-wait")
		}
		if *timeout >= 0 {
			loginArgs = append(loginArgs, "--timeout", strconv.Itoa(*timeout))
		}
		if *switchService {
			loginArgs = append(loginArgs, "--switch-service")
		}
		loginAny, loginErr := cmdAuthLogin(ctx, a, loginArgs)
		if loginErr != nil {
			failure := asFailure(loginErr)
			if failure.Code == "AUTH_PENDING" {
				details := map[string]any{"skills": installedSkills}
				if orig, ok := failure.Details.(map[string]any); ok {
					for k, v := range orig {
						details[k] = v
					}
				}
				return nil, &Failure{
					Code:    "AUTH_PENDING",
					Message: "Still waiting for browser approval; run `muvloom setup` (or `muvloom auth login`) again to resume",
					Details: details,
				}
			}
			return nil, loginErr
		}
		loginMap, _ := loginAny.(map[string]any)
		if loginState, _ := loginMap["state"].(string); loginState == "pending" {
			return map[string]any{
				"state":         "pending",
				"api_url":       a.APIURL,
				"skills":        installedSkills,
				"pending_login": loginMap,
			}, nil
		}
		statusMap = loginMap
		switch postState, _ := statusMap["state"].(string); postState {
		case "ready":
		case "outdated":
			return nil, fail("UPGRADE_REQUIRED", "This CLI (%v) is older than the server minimum (%v); run `muvloom update self`", statusMap["cli_version"], statusMap["min_cli_version"])
		case "unreachable":
			if errMap, ok := statusMap["error"].(map[string]string); ok && errMap["code"] != "" {
				return nil, fail(errMap["code"], "%s", errMap["message"])
			}
			return nil, fail("TEMPORARILY_UNAVAILABLE", "Could not reach %s; retry shortly", a.APIURL)
		default:
			return nil, fail("AUTH_REQUIRED", "Sign-in did not complete (state: %s)", postState)
		}
	}

	// 3. Read live capabilities + run zero-cost images validate smoke check.
	c, err := a.apiClient(ctx)
	if err != nil {
		return nil, err
	}
	var caps map[string]any
	if err := retryReadonly(ctx, func() error {
		return c.Do(ctx, http.MethodGet, "/v1/capabilities", nil, &caps)
	}); err != nil {
		return nil, err
	}
	var smokeQuote map[string]any
	if err := retryReadonly(ctx, func() error {
		return c.Do(ctx, http.MethodPost, "/v1/image-jobs/validate", map[string]any{"prompt": "setup smoke"}, &smokeQuote)
	}); err != nil {
		return nil, err
	}

	result := map[string]any{
		"state":            "ready",
		"cli_version":      statusMap["cli_version"],
		"api_url":          a.APIURL,
		"credential_store": statusMap["credential_store"],
		"account":          statusMap["account"],
		"credits":          statusMap["credits"],
		"member":           statusMap["member"],
		"skills":           installedSkills,
		"default_model":    caps["default_model"],
		"models":           caps["models"],
		"smoke_validate":   smokeQuote,
	}
	if updatedFrom, ok := statusMap["cli_updated_from"]; ok {
		result["cli_updated_from"] = updatedFrom
	}
	return result, nil
}
