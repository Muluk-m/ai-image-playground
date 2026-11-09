package cli

import (
	"flag"
	"fmt"
	"io"
	"sort"
	"strings"
)

// helpRequest is returned by parse when the command line asks for the command's help.
type helpRequest struct{ flags *flag.FlagSet }

func (*helpRequest) Error() string { return "help requested" }

// help prints a help page on stdout. Help is text in both output modes: it is read, not parsed.
func (a *App) help(text string) int {
	if _, err := io.WriteString(a.Out, text); err != nil {
		fmt.Fprintf(a.Err, "muvloom: could not write output: %v\n", err)
		return ExitInternal
	}
	return ExitOK
}

// commandFlagsHelp lists the flags every command accepts; mainHelp adds --version, which
// only stands alone.
const commandFlagsHelp = `GLOBAL FLAGS
  --json          Print one JSON object instead of text (for scripts and agents)
  -h, --help      Show help for a command
`

const globalFlagsHelp = commandFlagsHelp + "  -v, --version   Print the CLI version (on its own)\n"

func mainHelp() string {
	var b strings.Builder
	b.WriteString("muvloom: generate images with Muvloom (幕芽) from the command line\n\n")
	b.WriteString("USAGE\n  muvloom <command> [flags]\n")
	width := 0
	for _, section := range commandList {
		for _, cmd := range section.commands {
			width = max(width, len(cmd.name))
		}
	}
	for _, section := range commandList {
		fmt.Fprintf(&b, "\n%s\n", section.section)
		for _, cmd := range section.commands {
			fmt.Fprintf(&b, "  %-*s  %s\n", width, cmd.name, cmd.summary)
		}
	}
	b.WriteString("\n" + globalFlagsHelp)
	b.WriteString(`
ENVIRONMENT
  MUVLOOM_API_URL             Service for the first sign-in; later runs use the stored connection
  MUVLOOM_NO_BROWSER=1        Print the approval link instead of opening a browser (SSH, containers)
  MUVLOOM_CONFIG_DIR          Where the connection is kept; a directory set here is its own login, in files, never the keychain
  MUVLOOM_CREDENTIALS_STORE   "file" keeps credentials in the config directory instead of the keychain

EXIT CODES
  0 success   2 invalid command or request   3 sign-in needed   4 rejected, or the job failed
  5 not enough credits or quota used up   6 temporary, retry   7 CLI too old   1 unexpected

Run "muvloom <command> --help" for a command's flags and examples.
`)
	return b.String()
}

func subcommandNames(subs []command) string {
	names := make([]string, len(subs))
	for i, cmd := range subs {
		names[i] = strings.Fields(cmd.name)[1]
	}
	return strings.Join(names, ", ")
}

func groupHelp(name string, subs []command) string {
	var b strings.Builder
	fmt.Fprintf(&b, "USAGE\n  muvloom %s <command> [flags]\n\nCOMMANDS\n", name)
	width := 0
	for _, cmd := range subs {
		width = max(width, len(cmd.name))
	}
	for _, cmd := range subs {
		fmt.Fprintf(&b, "  %-*s  %s\n", width, cmd.name, cmd.summary)
	}
	fmt.Fprintf(&b, "\nRun \"muvloom %s <command> --help\" for a command's flags.\n", name)
	return b.String()
}

// placeholders name the value each flag takes in help; a flag not listed takes VALUE.
var placeholders = map[string]string{
	"prompt": "TEXT", "prompt-file": "FILE", "model": "ID", "aspect-ratio": "RATIO",
	"image-size": "SIZE", "quality": "LEVEL", "ref": "FILE|MEDIA_ID", "max-credits": "N",
	"output-format": "gif|svg", "frames": "N", "frame-duration-ms": "MS", "frame-size": "WxH",
	"idempotency-key": "KEY", "wait": "SECONDS", "download": "DIR", "limit": "N", "cursor": "ID",
	"timeout": "SECONDS", "output": "PATH", "host": "claude-code|codex", "scope": "user|project",
	"dir": "DIRECTORY",
}

// flagOrder puts the flags a command cannot do without first; the rest follow alphabetically.
var flagOrder = map[string]int{"prompt": -2, "prompt-file": -1}

var examples = map[string][]string{
	"auth login": {
		"muvloom auth login",
		"MUVLOOM_NO_BROWSER=1 muvloom auth login --no-wait   # print the link, approve elsewhere",
	},
	"images create": {
		`muvloom images create --prompt "a cat sticker, white background" --wait 300 --download ./out`,
		`muvloom images create --prompt "the same bottle on a beach" --ref ./bottle.png --aspect-ratio 1:1 --wait 300 --download ./out`,
		`muvloom images create --model gpt-image-2.6-flare --output-format gif --frames 8 --prompt "a cat waving, looping" --wait 300 --download ./out`,
	},
	"images validate": {
		`muvloom images validate --prompt "a poster" --image-size 4K`,
	},
	"jobs wait":          {"muvloom jobs wait JOB_ID --timeout 300"},
	"jobs list":          {"muvloom jobs list --idempotency-key KEY   # find a job whose submit response was lost"},
	"artifacts download": {"muvloom artifacts download ARTIFACT_ID --output ./out/cat"},
	"skill install": {
		"muvloom skill install --host claude-code",
		"muvloom skill install --host codex --scope project",
		"muvloom skill install --dir ~/.workbuddy/skills   # any host's skills directory",
	},
}

// notes add what a command's flags alone do not say.
var notes = map[string]string{
	"images create": "Models, sizes, output formats and their limits: muvloom capabilities.\n" +
		"A GIF or SVG takes no --ref, --aspect-ratio, --image-size or --quality.",
	"images validate": "Same flags as images create. Creates nothing and charges nothing.",
	"auth login":      "Opens the approval page and waits. Run it again after a timeout: it resumes the same sign-in.",
	"skill install": "--dir takes the host's skills directory; the Skill is installed into <dir>/muvloom and the\n" +
		"directory is remembered, so `muvloom auth status` keeps that copy up to date too.",
}

func commandHelp(cmd command, fs *flag.FlagSet) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\nUSAGE\n  muvloom %s", cmd.summary, cmd.name)
	if cmd.args != "" {
		b.WriteString(" " + cmd.args)
	}
	b.WriteString("\n")
	var lines [][2]string
	width := 0
	if fs != nil {
		var flags []*flag.Flag
		fs.VisitAll(func(f *flag.Flag) { flags = append(flags, f) })
		sort.SliceStable(flags, func(i, j int) bool {
			if flagOrder[flags[i].Name] != flagOrder[flags[j].Name] {
				return flagOrder[flags[i].Name] < flagOrder[flags[j].Name]
			}
			return flags[i].Name < flags[j].Name
		})
		for _, f := range flags {
			left := "--" + f.Name
			if boolean, ok := f.Value.(interface{ IsBoolFlag() bool }); !ok || !boolean.IsBoolFlag() {
				placeholder := placeholders[f.Name]
				if placeholder == "" {
					placeholder = "VALUE"
				}
				left += " " + placeholder
			}
			usage := f.Usage
			if def := f.DefValue; def != "" && def != "0" && def != "false" && def != "-1" && !strings.Contains(usage, "default") {
				usage += " (default " + def + ")"
			}
			lines = append(lines, [2]string{left, usage})
			width = max(width, len(left))
		}
	}
	if len(lines) > 0 {
		b.WriteString("\nFLAGS\n")
		for _, line := range lines {
			fmt.Fprintf(&b, "  %-*s  %s\n", width, line[0], line[1])
		}
	}
	if note := notes[cmd.name]; note != "" {
		b.WriteString("\n" + note + "\n")
	}
	if list := examples[cmd.name]; len(list) > 0 {
		b.WriteString("\nEXAMPLES\n")
		for _, example := range list {
			b.WriteString("  " + example + "\n")
		}
	}
	b.WriteString("\n" + commandFlagsHelp)
	return b.String()
}
