# GIF and animated-image requests

The current CLI submits still-image jobs. Its model operations `generate` and
`edit` do not establish native animation support. Do not infer animation support
from a model name or promise a native animated GIF from these commands.

For a GIF request, briefly explain the actual workflow before spending: generate
the source artwork with Muvloom, then animate and encode it with suitable local
tools available on the agent host. Choose a sensible short looping motion when
the user has not specified one; do not add a confirmation gate just for this
explanation. Honor a request for native animation only: report the current
limitation instead of substituting local animation.

Check that local animation tools are available before generating the artwork.
If a required tool is unavailable, resolve it within existing authorization or
explain the blocker before spending. Use the normal Skill flow for the Muvloom
artwork. Keep product identity or character appearance consistent when creating
multiple source frames. For an existing image that only needs local animation,
use local tools without creating an unnecessary Muvloom job.

Inspect the finished animation with the host's preview tools and verify its
actual format, pixel dimensions, multiple distinct frames, frame timing and loop
behavior. A static image saved with a `.gif` extension is not an animation.
Deliver the animated file with an inline preview when supported and a download
link. Describe it as Muvloom artwork animated locally; distinguish it from native
animation generation. Report any unmet motion requirements accurately.
