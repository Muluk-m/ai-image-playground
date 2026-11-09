package version

import (
	"regexp"
	"testing"
)

func TestCurrentIsAnExactStableVersion(t *testing.T) {
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(Current) {
		t.Fatalf("VERSION must hold an exact X.Y.Z version, got %q", Current)
	}
}

func TestCurrentDropsTheTrailingNewline(t *testing.T) {
	// The file is edited by hand and ends with a newline; a version carrying it
	// would leak into HTTP user agents, tag names and Skill metadata.
	if raw == Current {
		t.Skip("VERSION has no surrounding whitespace to trim")
	}
	if len(Current) == 0 {
		t.Fatal("VERSION must not be empty")
	}
}
