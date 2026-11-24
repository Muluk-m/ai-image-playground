package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImagesCreateDownloadAutoWaits(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	outDir := filepath.Join(t.TempDir(), "out")
	r := execute(t, app, "images", "create", "--prompt", "a white ceramic mug", "--download", outDir)
	if r.code != ExitOK {
		t.Fatalf("download without --wait = %d %s", r.code, r.stdout)
	}
	data := r.out["data"].(map[string]any)
	downloads, _ := data["downloads"].([]any)
	if len(downloads) != 1 {
		t.Fatalf("expected 1 downloaded file, got %v", data["downloads"])
	}
	savedPath := downloads[0].(map[string]any)["path"].(string)
	if !strings.HasPrefix(savedPath, outDir+string(os.PathSeparator)) {
		t.Fatalf("expected saved file inside %s, got %s", outDir, savedPath)
	}
}

func TestImagesCreateDownloadRejectsExplicitZeroWait(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	r := execute(t, app, "images", "create", "--prompt", "a mug", "--wait", "0", "--download", t.TempDir())
	if r.code != ExitInvalid || !strings.Contains(r.stdout, "--download requires waiting") {
		t.Fatalf("expected USAGE error, got %d %s", r.code, r.stdout)
	}
}

func TestImagesCreateRejectsMissingLocalRefPath(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	r := execute(t, app, "images", "create", "--prompt", "edit", "--ref", "./does-not-exist.png")
	if r.code != ExitInvalid || !strings.Contains(r.stdout, "Reference file not found") {
		t.Fatalf("expected missing ref file error, got %d %s", r.code, r.stdout)
	}
	if f.submitCalls != 0 {
		t.Fatalf("should not submit request when local --ref is missing, got %d calls", f.submitCalls)
	}
}

func TestImagesCreateRejectsDirectoryRef(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	dir := t.TempDir()
	r := execute(t, app, "images", "create", "--prompt", "edit", "--ref", dir)
	if r.code != ExitInvalid || !strings.Contains(r.stdout, "not a directory") {
		t.Fatalf("expected directory ref error, got %d %s", r.code, r.stdout)
	}
}

func TestArtifactDownloadIntoExistingDirectory(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	dir := t.TempDir()
	r := execute(t, app, "artifacts", "download", "art_1", "--output", dir)
	if r.code != ExitOK {
		t.Fatalf("download into dir = %d %s", r.code, r.stdout)
	}
	savedPath := r.out["data"].(map[string]any)["path"].(string)
	want := filepath.Join(dir, "art_1.png")
	if savedPath != want {
		t.Fatalf("saved path = %q, want %q", savedPath, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("expected file at %s: %v", want, err)
	}
}

func TestSkillInstallDefaultsToAutoHost(t *testing.T) {
	f := newFakeServer(t)
	app := transferApp(t, f)
	if err := os.MkdirAll(filepath.Join(app.Home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := execute(t, app, "skill", "install")
	if r.code != ExitOK {
		t.Fatalf("skill install without --host = %d %s", r.code, r.stdout)
	}
}
