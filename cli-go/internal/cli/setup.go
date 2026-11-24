package cli

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

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
	timeout := fs.Int("timeout", -1, "Seconds to wait for approval; omitted: as long as the authorization link is valid")
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

	// 1. Install or refresh the bundled Skill (unless --host none), preserving copies already
	// hot-updated to a newer SkillVersion or customized by the user.
	var installedSkills []skill.Result
	var skillFailures []skill.HostInstallFailure
	switch *host {
	case "none":
		installedSkills = []skill.Result{}
	case "auto":
		autoRes, err := skill.EnsureAutoInstalled(skill.InstallOptions{
			Scope: *scope,
			Home:  a.Home,
			CWD:   a.CWD,
		}, a.Getenv)
		if err != nil {
			return nil, fail("INVALID_REQUEST", "%v", err)
		}
		installedSkills = autoRes.Installed
		skillFailures = autoRes.Failed
		for _, f := range skillFailures {
			a.progress("Could not install the muvloom Skill for %s (%s)", f.Host, f.Reason)
		}
	default:
		res, err := skill.EnsureInstalled(skill.InstallOptions{
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

	outdatedFailure := func(m map[string]any) error {
		if updatedTo, ok := m["cli_updated_to"].(string); ok && updatedTo != "" {
			return fail("UPGRADE_REQUIRED", "CLI binary updated on disk to %s (running %v < server minimum %v); re-run `muvloom setup` to continue with the updated binary", updatedTo, m["cli_version"], m["min_cli_version"])
		}
		return fail("UPGRADE_REQUIRED", "This CLI (%v) is older than the server minimum (%v); run `muvloom update self`", m["cli_version"], m["min_cli_version"])
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
		return nil, outdatedFailure(statusMap)
	case "unreachable":
		if errMap, ok := statusMap["error"].(map[string]string); ok && errMap["code"] != "" {
			return nil, fail(errMap["code"], "%s", errMap["message"])
		}
		return nil, fail("TEMPORARILY_UNAVAILABLE", "Could not reach %s; retry shortly", a.APIURL)
	case "service_mismatch":
		pending, pErr := a.Store.LoadPending()
		freshPending := pErr == nil && sameService(pending.BaseURL, a.APIURL) && time.Now().Before(pending.ExpiresAt)
		if !*switchService && !freshPending {
			connURL, _ := statusMap["connection_api_url"].(string)
			if rawOrigin != "" {
				return nil, &Failure{
					Code:    "SERVICE_MISMATCH",
					Message: "Requested origin points at " + a.APIURL + ", but this machine is signed in to " + connURL + ". Omit --origin to keep the existing connection, or run `muvloom setup --origin " + rawOrigin + " --switch-service` to sign in to " + a.APIURL + " instead",
					Details: map[string]string{"api_url": a.APIURL, "connection_api_url": connURL},
				}
			}
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
			pendingOut := map[string]any{
				"state":         "pending",
				"api_url":       a.APIURL,
				"skills":        installedSkills,
				"pending_login": loginMap,
			}
			if len(skillFailures) > 0 {
				pendingOut["skill_install_failures"] = skillFailures
			}
			return pendingOut, nil
		}
		statusMap = loginMap
		switch postState, _ := statusMap["state"].(string); postState {
		case "ready":
		case "outdated":
			return nil, outdatedFailure(statusMap)
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
	smokePayload, err := buildSmokeValidatePayload(caps)
	if err != nil {
		return nil, err
	}
	var smokeQuote map[string]any
	if err := retryReadonly(ctx, func() error {
		return c.Do(ctx, http.MethodPost, "/v1/image-jobs/validate", smokePayload, &smokeQuote)
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
	if len(skillFailures) > 0 {
		result["skill_install_failures"] = skillFailures
	}
	if updatedTo, ok := statusMap["cli_updated_to"]; ok {
		result["cli_updated_to"] = updatedTo
	}
	return result, nil
}

func buildSmokeValidatePayload(caps map[string]any) (map[string]any, error) {
	defaultModel, _ := caps["default_model"].(string)
	modelsRaw, hasModels := caps["models"].([]any)
	var chosen map[string]any
	for _, item := range modelsRaw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		if id == "" {
			continue
		}
		if chosen == nil || (defaultModel != "" && id == defaultModel) {
			chosen = m
			if defaultModel != "" && id == defaultModel {
				break
			}
		}
	}
	if chosen == nil && defaultModel == "" && hasModels && len(modelsRaw) == 0 {
		return nil, fail("CAPABILITY_UNAVAILABLE", "No image models are currently available for this account")
	}
	payload := map[string]any{"prompt": "setup smoke"}
	if chosen != nil {
		if id, _ := chosen["id"].(string); id != "" {
			payload["model"] = id
		}
		if size, _ := chosen["default_image_size"].(string); size != "" {
			payload["image_size"] = size
		}
		if qualitiesRaw, ok := chosen["qualities"].([]any); ok && len(qualitiesRaw) > 0 {
			firstQuality := ""
			for _, qItem := range qualitiesRaw {
				q, _ := qItem.(string)
				if q == "" {
					continue
				}
				if firstQuality == "" {
					firstQuality = q
				}
				if q == "medium" {
					firstQuality = q
					break
				}
			}
			if firstQuality != "" {
				payload["quality"] = firstQuality
			}
		}
	} else if defaultModel != "" {
		payload["model"] = defaultModel
	}
	return payload, nil
}
