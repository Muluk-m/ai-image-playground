package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
)

// Text output keeps the JSON field names, so `key: value` lines read the same to a person and
// to an agent following instructions written for the JSON fields. Lists that people scan get
// a compact layout of their own; everything else uses the generic one.

// field is one member of a JSON object, in the order the server sent it.
type field struct {
	key   string
	value any
}

type object []field

func (o object) get(key string) any {
	for _, f := range o {
		if f.key == key {
			return f.value
		}
	}
	return nil
}

// ordered converts data to JSON values whose objects keep their field order.
func ordered(data any) (any, error) {
	raw, ok := data.(json.RawMessage)
	if ok && len(raw) == 0 {
		return nil, nil
	}
	if !ok {
		var buf bytes.Buffer
		encoder := json.NewEncoder(&buf)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(data); err != nil {
			return nil, err
		}
		raw = buf.Bytes()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decodeValue(decoder)
}

func decodeValue(d *json.Decoder) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch token {
	case json.Delim('{'):
		var o object
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, err
			}
			value, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			o = append(o, field{key.(string), value})
		}
		_, err := d.Token()
		return o, err
	case json.Delim('['):
		list := []any{}
		for d.More() {
			value, err := decodeValue(d)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err := d.Token()
		return list, err
	}
	return token, nil
}

func (a *App) writeText(data any) error {
	value, err := ordered(data)
	if err != nil {
		return err
	}
	var b strings.Builder
	switch a.command {
	case "version":
		o, _ := value.(object)
		fmt.Fprintf(&b, "muvloom %s (%s/%s)\n", scalar(o.get("version")), scalar(o.get("os")), scalar(o.get("arch")))
	case "capabilities":
		writeCapabilities(&b, value)
	case "jobs list":
		writeList(&b, value, "jobs", []string{"job_id", "status", "model", "submitted_at", "actual_credits", "artifacts"}, "jobs")
	case "auth status":
		o, _ := value.(object)
		writeValue(&b, reorder(o, "state", "api_url", "api_url_source", "connection_api_url", "account", "credits", "member",
			"pending_login", "error", "cli_version", "min_cli_version", "update_required"), "")
	case "media list":
		writeList(&b, value, "media", []string{"media_id", "content_type", "width", "height", "bytes", "created_at"}, "uploaded images")
	default:
		writeValue(&b, value, "")
	}
	_, err = io.WriteString(a.Out, b.String())
	return err
}

// reorder moves the named fields first, in that order, keeping the rest as they were.
func reorder(o object, first ...string) object {
	out := make(object, 0, len(o))
	for _, key := range first {
		for _, f := range o {
			if f.key == key {
				out = append(out, f)
			}
		}
	}
	for _, f := range o {
		if !slices.Contains(first, f.key) {
			out = append(out, f)
		}
	}
	return out
}

// writeValue prints a JSON value as indented `key: value` lines.
func writeValue(b *strings.Builder, value any, indent string) {
	switch v := value.(type) {
	case object:
		for _, f := range v {
			writeField(b, f.key, f.value, indent)
		}
	case []any:
		for _, item := range v {
			writeItem(b, item, indent)
		}
	default:
		b.WriteString(indent + scalar(v) + "\n")
	}
}

func writeField(b *strings.Builder, key string, value any, indent string) {
	switch v := value.(type) {
	case object:
		if len(v) == 0 {
			fmt.Fprintf(b, "%s%s: none\n", indent, key)
			return
		}
		fmt.Fprintf(b, "%s%s:\n", indent, key)
		writeValue(b, v, indent+"  ")
	case []any:
		if len(v) == 0 {
			fmt.Fprintf(b, "%s%s: none\n", indent, key)
			return
		}
		if allScalars(v) {
			parts := make([]string, len(v))
			for i, item := range v {
				parts[i] = scalar(item)
			}
			fmt.Fprintf(b, "%s%s: %s\n", indent, key, strings.Join(parts, ", "))
			return
		}
		fmt.Fprintf(b, "%s%s:\n", indent, key)
		for _, item := range v {
			writeItem(b, item, indent+"  ")
		}
	default:
		text := fieldScalar(key, v)
		if strings.Contains(text, "\n") {
			fmt.Fprintf(b, "%s%s: |\n", indent, key)
			for _, line := range strings.Split(text, "\n") {
				b.WriteString(indent + "  " + line + "\n")
			}
			return
		}
		fmt.Fprintf(b, "%s%s: %s\n", indent, key, text)
	}
}

// writeItem prints one list entry, YAML style: the first line carries the dash.
func writeItem(b *strings.Builder, item any, indent string) {
	o, ok := item.(object)
	if !ok || len(o) == 0 {
		var inner strings.Builder
		writeValue(&inner, item, "")
		b.WriteString(indent + "- " + strings.TrimSuffix(inner.String(), "\n") + "\n")
		return
	}
	var inner strings.Builder
	writeValue(&inner, o, "")
	for i, line := range strings.Split(strings.TrimSuffix(inner.String(), "\n"), "\n") {
		if i == 0 {
			b.WriteString(indent + "- " + line + "\n")
		} else {
			b.WriteString(indent + "  " + line + "\n")
		}
	}
}

func allScalars(list []any) bool {
	for _, item := range list {
		switch item.(type) {
		case object, []any:
			return false
		}
	}
	return true
}

func scalar(value any) string {
	switch v := value.(type) {
	case nil:
		return "none"
	case string:
		return v
	case json.Number:
		return v.String()
	case bool:
		if v {
			return "true"
		}
		return "false"
	}
	return fmt.Sprint(value)
}

// fieldScalar formats a value for people where its key says what it is: millisecond
// timestamps as local time, byte counts with a unit.
func fieldScalar(key string, value any) string {
	if number, ok := value.(json.Number); ok {
		n, err := number.Int64()
		switch {
		case err != nil:
		case strings.HasSuffix(key, "_at") && n > 1e12:
			return time.UnixMilli(n).Local().Format("2006-01-02 15:04:05")
		case key == "bytes":
			return byteSize(n)
		}
	}
	return scalar(value)
}

func byteSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// writeList prints a page of records as an aligned table.
func writeList(b *strings.Builder, value any, key string, columns []string, noun string) {
	o, _ := value.(object)
	items, _ := o.get(key).([]any)
	if len(items) == 0 {
		fmt.Fprintf(b, "No %s.\n", noun)
	} else {
		rows := [][]string{columns}
		for _, item := range items {
			record, _ := item.(object)
			row := make([]string, len(columns))
			for i, column := range columns {
				row[i] = cell(column, record.get(column))
			}
			rows = append(rows, row)
		}
		writeTable(b, rows, "")
	}
	if cursor := o.get("next_cursor"); cursor != nil {
		fmt.Fprintf(b, "\nnext_cursor: %s (pass it as --cursor for the next page)\n", scalar(cursor))
	}
}

// cell fits a value into one table cell: a list of records becomes their ids.
func cell(key string, value any) string {
	list, ok := value.([]any)
	if !ok {
		return fieldScalar(key, value)
	}
	ids := make([]string, 0, len(list))
	for _, item := range list {
		if record, ok := item.(object); ok && len(record) > 0 {
			ids = append(ids, scalar(record[0].value))
		} else {
			ids = append(ids, scalar(item))
		}
	}
	if len(ids) == 0 {
		return "-"
	}
	return strings.Join(ids, ",")
}

func writeTable(b *strings.Builder, rows [][]string, indent string) {
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for i, cell := range row {
			widths[i] = max(widths[i], len([]rune(cell)))
		}
	}
	for _, row := range rows {
		var line strings.Builder
		for i, cell := range row {
			if i == len(row)-1 {
				line.WriteString(cell)
				break
			}
			line.WriteString(cell + strings.Repeat(" ", widths[i]-len([]rune(cell))+2))
		}
		b.WriteString(indent + strings.TrimRight(line.String(), " ") + "\n")
	}
}

// writeCapabilities prints one block per model with what it accepts and makes. `--json` has
// every field; this keeps the ones a person picks a model by.
func writeCapabilities(b *strings.Builder, value any) {
	o, ok := value.(object)
	models, _ := o.get("models").([]any)
	if !ok || len(models) == 0 {
		writeValue(b, value, "")
		return
	}
	fmt.Fprintf(b, "default_model: %s\n", scalar(o.get("default_model")))
	for _, item := range models {
		model, _ := item.(object)
		header := scalar(model.get("id"))
		if label := model.get("label"); label != nil {
			header += "  " + scalar(label)
		}
		if model.get("default") == true {
			header += "  (default)"
		}
		b.WriteString("\n" + header + "\n")
		line := func(key string, text string) {
			if text != "" {
				fmt.Fprintf(b, "  %s: %s\n", key, text)
			}
		}
		line("output_formats", join(model.get("output_formats")))
		line("operations", join(model.get("operations")))
		line("aspect_ratios", join(model.get("aspect_ratios")))
		sizes := join(model.get("image_sizes"))
		if def := model.get("default_image_size"); sizes != "" && def != nil {
			sizes += " (default " + scalar(def) + ")"
		}
		line("image_sizes", sizes)
		line("qualities", join(model.get("qualities")))
		if refs := model.get("max_reference_images"); refs != nil {
			line("max_reference_images", scalar(refs))
		}
		line("price", credits(model.get("price")))
		if seconds := model.get("typical_duration_seconds"); seconds != nil {
			line("typical_duration_seconds", scalar(seconds))
		}
		if gif, ok := model.get("gif").(object); ok {
			b.WriteString("  gif (--output-format gif):\n")
			writeGif(b, gif, "    ")
		}
		if svg, ok := model.get("svg").(object); ok {
			fmt.Fprintf(b, "  svg (--output-format svg): %s\n", credits(svg.get("price")))
		}
	}
	if limits, ok := o.get("limits").(object); ok {
		b.WriteString("\nlimits:\n")
		writeValue(b, limits, "  ")
	}
	b.WriteString("\nPrices are base estimates; `muvloom images validate` quotes an exact request. `--json` lists every field.\n")
}

func join(value any) string {
	list, _ := value.([]any)
	parts := make([]string, len(list))
	for i, item := range list {
		parts[i] = scalar(item)
	}
	return strings.Join(parts, ", ")
}

func credits(value any) string {
	price, _ := value.(object)
	if estimate := price.get("estimated_credits"); estimate != nil {
		return "~" + scalar(estimate) + " credits"
	}
	return ""
}

func writeGif(b *strings.Builder, gif object, indent string) {
	if frames, ok := gif.get("frame_count").(object); ok {
		fmt.Fprintf(b, "%sframes: %s-%s (default %s)\n", indent,
			scalar(frames.get("min")), scalar(frames.get("max")), scalar(frames.get("default")))
	}
	if duration, ok := gif.get("frame_duration_ms").(object); ok {
		fmt.Fprintf(b, "%sframe_duration_ms: %s-%s in steps of %s (default %s)\n", indent,
			scalar(duration.get("min")), scalar(duration.get("max")), scalar(duration.get("step")), scalar(duration.get("default")))
	}
	if sizes, ok := gif.get("frame_sizes").([]any); ok {
		limits, _ := gif.get("max_frames_by_size").(object)
		described := make([]string, len(sizes))
		for i, size := range sizes {
			described[i] = scalar(size)
			if most := limits.get(scalar(size)); most != nil {
				described[i] += " (up to " + scalar(most) + " frames)"
			}
		}
		text := strings.Join(described, ", ")
		if def := gif.get("default_frame_size"); def != nil {
			text += "; default " + scalar(def)
		}
		fmt.Fprintf(b, "%sframe_sizes: %s\n", indent, text)
	}
	if price := credits(gif.get("price")); price != "" {
		fmt.Fprintf(b, "%sprice: %s with the defaults\n", indent, price)
	}
}

// hints say what to do next for the errors a person can act on.
var hints = map[string]string{
	"UNAUTHENTICATED":             "Run `muvloom auth login` to connect this machine.",
	"AUTH_REQUIRED":               "Run `muvloom auth status`; if it is not ready, run `muvloom auth login`.",
	"AUTH_PENDING":                "Approve the request in the browser, then run `muvloom auth login` again; it resumes the same sign-in.",
	"AUTH_EXPIRED":                "Run `muvloom auth login` to start a new sign-in.",
	"AUTH_DENIED":                 "The request was declined in the browser. Run `muvloom auth login` to try again.",
	"SERVICE_MISMATCH":            "Unset MUVLOOM_API_URL to use the stored connection, or run `muvloom auth login --switch-service`.",
	"INSUFFICIENT_CREDITS":        "Top up credits on the website, or choose a cheaper model or size.",
	"MAX_CREDITS_EXCEEDED":        "Raise --max-credits or choose a cheaper request.",
	"PLAN_REQUIRED":               "This request needs a membership; choose a smaller size or another model.",
	"IDEMPOTENCY_CONFLICT":        "This key was used for a different request; use a new --idempotency-key.",
	"FILE_EXISTS":                 "Choose another --output; existing files are never replaced.",
	"MODEL_UNAVAILABLE":           "Run `muvloom capabilities` for the models available now.",
	"RATE_LIMITED":                "Wait a moment and retry.",
	"NETWORK_ERROR":               "Check the network and retry.",
	"TEMPORARILY_UNAVAILABLE":     "Retry in a moment.",
	"UNSUPPORTED_VERSION":         "This CLI is too old: run `muvloom update check` and install the latest release.",
	"UPGRADE_REQUIRED":            "This CLI is too old: run `muvloom update check` and install the latest release.",
	"CREDENTIAL_STORE_UNWRITABLE": "Make the muvloom config directory writable (or set MUVLOOM_CONFIG_DIR), then run `muvloom auth login` again.",
}

func (a *App) failureText(failure *Failure) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Error: %s (%s)\n", failure.Message, failure.Code)
	if failure.Details != nil {
		if details, err := ordered(failure.Details); err == nil {
			var inner strings.Builder
			writeValue(&inner, details, "  ")
			b.WriteString(inner.String())
		}
	}
	hint := hints[failure.Code]
	if failure.Code == "USAGE" {
		hint = "Run `muvloom --help` for the commands."
		if a.command != "" {
			hint = "Run `muvloom " + a.command + " --help` for its usage."
		}
	}
	// A message that already names the command to run needs no second one.
	if hint != "" && (failure.Code == "USAGE" || !strings.Contains(failure.Message, "`muvloom ")) {
		b.WriteString(hint + "\n")
	}
	return b.String()
}
