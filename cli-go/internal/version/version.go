// Package version holds the single source of the muvloom CLI release version.
//
// VERSION in this directory is that source: the native CLI's `version` command,
// the bundled Skill's metadata version and cli-go/install/build-dist.py all read
// it, so a release bumps one file instead of several hand-edited copies. The
// value is embedded at compile time, which keeps `go run`/`go test` reporting the
// real release version without build flags; there is deliberately no -ldflags
// override, because an override could stamp a binary with a version that
// disagrees with the Skill metadata compiled into it.
//
// scripts/check-cli-version.mjs checks every remaining copy (workflow default
// tag, website pin, install guides, server minimum) against this file.
package version

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var raw string

// Current is the release version, as an exact X.Y.Z string.
var Current = strings.TrimSpace(raw)
