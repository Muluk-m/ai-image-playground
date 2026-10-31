package skill

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"
)

// The bundle must satisfy the Agent Skills layout: frontmatter with a matching name and
// a short description, references one level deep, and every linked reference present.
func TestBundleFollowsAgentSkillsLayout(t *testing.T) {
	body, err := fs.ReadFile(bundled, "assets/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	front := regexp.MustCompile(`(?s)^---\nname: (\S+)\ndescription: (.+?)\n---\n`).FindStringSubmatch(text)
	if front == nil || front[1] != "muvloom" {
		t.Fatalf("frontmatter must start with name: muvloom, got %q", text[:min(len(text), 120)])
	}
	if len(front[2]) > 1024 {
		t.Fatalf("description is %d characters; the spec allows 1024", len(front[2]))
	}
	for _, link := range regexp.MustCompile(`\]\((references/[^)]+)\)`).FindAllStringSubmatch(text, -1) {
		if strings.Count(link[1], "/") != 1 {
			t.Fatalf("%s is nested deeper than references/", link[1])
		}
		if _, err := fs.Stat(bundled, "assets/"+link[1]); err != nil {
			t.Fatalf("SKILL.md links to missing %s", link[1])
		}
	}
	if strings.Contains(text, "credits\":") || regexp.MustCompile(`\b\d+ credits\b`).MatchString(text) {
		t.Fatal("SKILL.md must not hard-code prices")
	}
}
