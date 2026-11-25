package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Muluk-m/ai-image-playground/cli-go/internal/auth"
)

func newOfflineApp(t *testing.T) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	var out, errBuf bytes.Buffer
	app := &App{
		Store: auth.Store{Dir: t.TempDir()},
		Out:   &out,
		Err:   &errBuf,
		Home:  t.TempDir(),
		CWD:   t.TempDir(),
	}
	return app, &out, &errBuf
}

func TestImagesCreateValidatesLocalFlagsBeforeAuthOrUpload(t *testing.T) {
	tmp := t.TempDir()
	refFile := filepath.Join(tmp, "ref.png")
	if err := os.WriteFile(refFile, []byte("fake"), 0o600); err != nil {
		t.Fatal(err)
	}
	promptFile := filepath.Join(tmp, "prompt.txt")
	if err := os.WriteFile(promptFile, []byte("from file"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("invalid idempotency key fails with ExitInvalid before auth", func(t *testing.T) {
		app, _, errBuf := newOfflineApp(t)
		code := app.Run([]string{
			"images", "create", "--prompt", "cat", "--ref", refFile, "--idempotency-key", "bad",
		})
		if code != ExitInvalid {
			t.Fatalf("expected ExitInvalid (%d), got %d: %s", ExitInvalid, code, errBuf.String())
		}
		if !strings.Contains(errBuf.String(), "--idempotency-key") {
			t.Fatalf("expected idempotency-key error, got: %s", errBuf.String())
		}
	})

	t.Run("prompt and prompt-file conflict fails with ExitInvalid", func(t *testing.T) {
		app, _, errBuf := newOfflineApp(t)
		code := app.Run([]string{
			"images", "create", "--prompt", "cat", "--prompt-file", promptFile,
		})
		if code != ExitInvalid {
			t.Fatalf("expected ExitInvalid (%d), got %d: %s", ExitInvalid, code, errBuf.String())
		}
		if !strings.Contains(errBuf.String(), "not both") {
			t.Fatalf("expected conflict error, got: %s", errBuf.String())
		}
	})

	t.Run("negative wait fails with ExitInvalid", func(t *testing.T) {
		app, _, errBuf := newOfflineApp(t)
		code := app.Run([]string{
			"images", "create", "--prompt", "cat", "--wait", "-5",
		})
		if code != ExitInvalid {
			t.Fatalf("expected ExitInvalid (%d), got %d: %s", ExitInvalid, code, errBuf.String())
		}
	})
}

func TestUnknownCommandSuggestsLikelyCommand(t *testing.T) {
	app, _, errBuf := newOfflineApp(t)
	code := app.Run([]string{"login"})
	if code != ExitInvalid {
		t.Fatalf("expected ExitInvalid (%d), got %d", ExitInvalid, code)
	}
	if !strings.Contains(errBuf.String(), `did you mean "muvloom auth login"`) {
		t.Fatalf("expected suggestion, got: %s", errBuf.String())
	}
}

func TestSkillInstallInvalidScopeReturnsUsage(t *testing.T) {
	app, _, errBuf := newOfflineApp(t)
	code := app.Run([]string{"skill", "install", "--host", "codex", "--scope", "global"})
	if code != ExitInvalid {
		t.Fatalf("expected ExitInvalid (%d), got %d: %s", ExitInvalid, code, errBuf.String())
	}
	if !strings.Contains(errBuf.String(), "--scope must be user or project") {
		t.Fatalf("expected scope message, got: %s", errBuf.String())
	}
}

func TestImagesCreatePositionalArgSuggestsPromptFlag(t *testing.T) {
	app, _, errBuf := newOfflineApp(t)
	code := app.Run([]string{"images", "create", "a cute cat"})
	if code != ExitInvalid {
		t.Fatalf("expected ExitInvalid (%d), got %d: %s", ExitInvalid, code, errBuf.String())
	}
	if !strings.Contains(errBuf.String(), `--prompt "a cute cat"`) {
		t.Fatalf("expected --prompt hint, got: %s", errBuf.String())
	}
}
