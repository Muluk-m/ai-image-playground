package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"strings"
	"testing"
)

// runText runs a command without --json and returns stdout, stderr and the exit code.
func runText(t *testing.T, app *App, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app.Out, app.Err = &stdout, &stderr
	code := app.Run(args)
	return stdout.String(), stderr.String(), code
}

func TestHelpIsTextAndSucceeds(t *testing.T) {
	f := newFakeServer(t)
	for _, args := range [][]string{nil, {"help"}, {"--help"}, {"-h"}, {"--json", "--help"}} {
		app := newApp(t, f, t.TempDir())
		out, errOut, code := runText(t, app, args...)
		if code != ExitOK || errOut != "" {
			t.Fatalf("muvloom %v: exit %d, stderr %q", args, code, errOut)
		}
		for _, want := range []string{"USAGE", "images create", "GLOBAL FLAGS", "--json"} {
			if !strings.Contains(out, want) {
				t.Fatalf("muvloom %v help lacks %q:\n%s", args, want, out)
			}
		}
	}
}

func TestCommandHelpListsItsFlagsWithoutTouchingTheConnection(t *testing.T) {
	f := newFakeServer(t)
	for _, args := range [][]string{{"images", "create", "--help"}, {"help", "images", "create"}, {"images", "create", "--prompt", "x", "-h"}} {
		app := newApp(t, f, t.TempDir())
		// Help must work before anything is read: a store or service lookup would fail here.
		app.APIURL = "not a url"
		out, _, code := runText(t, app, args...)
		if code != ExitOK {
			t.Fatalf("muvloom %v: exit %d", args, code)
		}
		for _, want := range []string{"muvloom images create --prompt TEXT", "--output-format gif|svg", "--frames N", "EXAMPLES"} {
			if !strings.Contains(out, want) {
				t.Fatalf("muvloom %v help lacks %q:\n%s", args, want, out)
			}
		}
	}
	app := newApp(t, f, t.TempDir())
	if out, _, code := runText(t, app, "jobs", "--help"); code != ExitOK || !strings.Contains(out, "jobs wait") {
		t.Fatalf("group help: exit %d\n%s", code, out)
	}
}

func TestTextResultsKeepFieldNamesAndFailuresGoToStderr(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	out, _, code := runText(t, app, "auth", "status")
	if code != ExitOK || !strings.HasPrefix(out, "state: unauthenticated\n") {
		t.Fatalf("status: exit %d\n%s", code, out)
	}
	if strings.Contains(out, "{") {
		t.Fatalf("text output contains JSON:\n%s", out)
	}
	out, errOut, code := runText(t, app, "jobs", "get", "job-1")
	if code != ExitAuth || out != "" {
		t.Fatalf("signed-out jobs get: exit %d, stdout %q", code, out)
	}
	if !strings.Contains(errOut, "(AUTH_REQUIRED)") && !strings.Contains(errOut, "(UNAUTHENTICATED)") {
		t.Fatalf("failure lacks its code: %q", errOut)
	}
	if !strings.Contains(errOut, "muvloom auth") {
		t.Fatalf("failure lacks the next step: %q", errOut)
	}
}

func TestUsageErrorsPointAtTheRightHelp(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	_, errOut, code := runText(t, app, "images", "create", "--bogus")
	if code != ExitInvalid || !strings.Contains(errOut, "unknown flag --bogus") || !strings.Contains(errOut, "muvloom images create --help") {
		t.Fatalf("exit %d: %q", code, errOut)
	}
	_, errOut, code = runText(t, app, "jobs")
	if code != ExitInvalid || !strings.Contains(errOut, "list, get, wait, cancel") {
		t.Fatalf("exit %d: %q", code, errOut)
	}
}

func TestJSONFlagWorksAnywhereBeforeADoubleDash(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	out, _, code := runText(t, app, "auth", "status", "--json")
	var envelope map[string]any
	if code != ExitOK || json.Unmarshal([]byte(out), &envelope) != nil || envelope["ok"] != true {
		t.Fatalf("exit %d: %q", code, out)
	}
	out, _, _ = runText(t, app, "version")
	if !strings.HasPrefix(out, "muvloom "+Version+" (") {
		t.Fatalf("version text: %q", out)
	}
}

func TestTextLayoutOfNestedValues(t *testing.T) {
	var b strings.Builder
	value, err := ordered(json.RawMessage(`{"job":{"job_id":"j1","status":"succeeded","submitted_at":1700000000000,"artifacts":[{"artifact_id":"a1","content_type":"image/gif"}]},"wait_timed_out":false,"tags":["a","b"],"empty":[],"note":null}`))
	if err != nil {
		t.Fatal(err)
	}
	writeValue(&b, value, "")
	got := b.String()
	for _, want := range []string{"job:\n  job_id: j1\n  status: succeeded\n", "  artifacts:\n    - artifact_id: a1\n      content_type: image/gif\n", "wait_timed_out: false\n", "tags: a, b\n", "empty: none\n", "note: none\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("layout lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "1700000000000") {
		t.Fatalf("millisecond timestamp not formatted:\n%s", got)
	}
}

func TestEveryCommandHasHelp(t *testing.T) {
	f := newFakeServer(t)
	for _, section := range commandList {
		for _, cmd := range section.commands {
			app := newApp(t, f, t.TempDir())
			app.APIURL = "not a url"
			args := append(strings.Fields(cmd.name), "--help")
			out, errOut, code := runText(t, app, args...)
			if code != ExitOK || !strings.Contains(out, "muvloom "+cmd.name) {
				t.Fatalf("muvloom %s --help: exit %d\n%s%s", cmd.name, code, out, errOut)
			}
		}
	}
}

func TestJSONFlagSpellings(t *testing.T) {
	f := newFakeServer(t)
	for args, wantJSON := range map[string]bool{
		"version -json": true, "version --json=true": true, "--json version --json=false": false, "version": false,
	} {
		app := newApp(t, f, t.TempDir())
		out, errOut, code := runText(t, app, strings.Fields(args)...)
		if code != ExitOK || strings.HasPrefix(out, "{") != wantJSON {
			t.Fatalf("muvloom %s: exit %d json=%v\n%s%s", args, code, wantJSON, out, errOut)
		}
	}
	app := newApp(t, f, t.TempDir())
	if _, errOut, _ := runText(t, app, "images", "create", "-bogus=1"); !strings.Contains(errOut, "unknown flag -bogus ") {
		t.Fatalf("flag spelling not kept: %q", errOut)
	}
}

// A flag value that looks like a global flag is still the value.
func TestGlobalFlagsAreNotTakenFromFlagValues(t *testing.T) {
	f := newFakeServer(t)
	app := newApp(t, f, t.TempDir())
	var got [][]string
	for _, value := range []string{"--json", "--json=false", "--help", "-h"} {
		rest, help := app.commandArgs([]string{"--prompt", value, "--wait", "5"}, imagesCreateFlags(t))
		if help || app.json {
			t.Fatalf("value %q taken as a flag: help=%v json=%v", value, help, app.json)
		}
		got = append(got, rest)
	}
	for i, rest := range got {
		if len(rest) != 4 || rest[1] == "" {
			t.Fatalf("case %d lost the value: %v", i, rest)
		}
	}
	rest, help := app.commandArgs([]string{"--prompt", "x", "--json", "--", "--help"}, imagesCreateFlags(t))
	if help || !app.json || strings.Join(rest, " ") != "--prompt x -- --help" {
		t.Fatalf("rest=%v help=%v json=%v", rest, help, app.json)
	}
}

func imagesCreateFlags(t *testing.T) *flag.FlagSet {
	t.Helper()
	cmd, _, _ := lookup([]string{"images", "create"})
	_, err := cmd.run(context.Background(), &App{}, []string{"--help"})
	var request *helpRequest
	if !errors.As(err, &request) {
		t.Fatalf("no flags: %v", err)
	}
	return request.flags
}
