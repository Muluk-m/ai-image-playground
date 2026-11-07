# GIF, animation and SVG requests

Read `muvloom capabilities` first. A model whose `output_formats` includes `gif`
generates a real animated GIF in one job; one that includes `svg` generates an SVG
vector file. Prefer this native output whenever a listed model supports the
request: it is one generation, with no local tools.

## Native GIF

Run `muvloom images create --model <id> --output-format gif --prompt "…"` with the
usual idempotency key, wait and download. Describe the motion in the prompt (what
moves, how, and that it loops). Optional flags come from the model's `gif` entry:

- `--frames N`: `frame_count.min`–`frame_count.max` (default `frame_count.default`);
  smoother motion needs more frames, and more frames cost more.
- `--frame-duration-ms MS`: time per frame within `frame_duration_ms` (min, max,
  step); `suggested_frame_durations_ms` lists the usual choices (shorter is faster
  motion).
- `--frame-size WxH`: one of `frame_sizes`. `max_frames_by_size` caps the frames
  for each size; pick a smaller size when the user needs more frames.

A native GIF takes no reference images and makes one image per request; do not
pass `--image-size`, `--aspect-ratio` or `--quality` with it. The server rejects an
invalid combination with `INVALID_REQUEST` before charging; fix the flags from the
message and the listed limits.

## Native SVG

Run `muvloom images create --model <id> --output-format svg --prompt "…"`. Suited to
logos, icons, flat illustrations and other vector artwork. It takes no reference
images and makes one file per request; do not pass `--quality`.

## When native output does not fit

Use local tools only when no listed model offers the format, when the user needs
something native output cannot do (a GIF from their reference image, more frames
or a larger size than the limits allow, a specific frame-by-frame sequence), or
when the user asks for it. Then generate the artwork with Muvloom and animate or
vectorize it with tools available on the host, checking they exist before
spending. Keep product identity or character appearance consistent across frames.
Say which path you took: a native Muvloom GIF/SVG, or Muvloom artwork animated or
converted locally.

## Delivery

Inspect the result with the host's preview tools. For a GIF, check it really has
multiple distinct frames and loops; a still image saved as `.gif` is not an
animation. Deliver the file with an inline preview when supported and its saved
path, and report any motion requirement that was not met.
