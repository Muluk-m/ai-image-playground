# Coordinated image sets

Use for e-commerce galleries, product detail images and other multi-image sets.
Preserve the requested platform, count and purpose. When unspecified, choose a
reasonable set and briefly state its scope before generating; this is a progress
update, not another approval gate.

## Plan the set

- Inspect the supplied product references. Identify visible product facts and
  separate them from unknown dimensions, materials, performance and service terms.
  Use verified information in the copy; omit unsupported claims.
- Give each image a distinct role. A product gallery can include a main image,
  clean product view, detail close-up, another supported view, usage scene and
  buying information. Adapt the roles to the product and available facts rather
  than imposing a fixed six-image template. Deliver separate images for these
  roles; a contact sheet is an additional preview.
- When the user requests research or rejects the visual direction, inspect
  relevant real examples with the host's search/browser tools before revising.
  Use them to decide composition and information hierarchy; keep the user's
  product as the identity reference and write original copy.
- Set shared product identity, colors, typography, lighting and layout rules.
  Reuse the original product reference for every generation. A generated style
  reference may supplement it, but must not replace product evidence. Keep new
  angles consistent with visible structure; request another photo only when
  unseen structure is essential to the requested deliverable.

## Generate and track

Choose the ratio for each planned placement and pass it with `--aspect-ratio`
when supported. A square gallery uses `--aspect-ratio 1:1`; a vertical detail
page may use a different supported ratio. Prompt text alone does not fix output
dimensions. Set `--image-size` when required by the user or placement.

Submit each image through the normal Skill flow, with its own prompt, output
path and idempotency key. Respect `capabilities.limits.concurrent_jobs`; use
sequential requests when the limit is one. Keep a manifest of image roles, flags,
keys, job/artifact IDs and downloaded paths so a partial run resumes only missing
work. Wait and download using the existing jobs as described in jobs.md.

## Inspect and deliver

Inspect every downloaded image, not just the contact sheet:

- Confirm the requested count, actual pixel dimensions and aspect ratios.
- Compare product shape, color, fittings and surface appearance across the set
  and against the original references.
- Read all visible copy for spelling, legibility and supported claims; check
  cropping, layout and whether each image fulfills its planned role.

Correct local packaging issues without another generation. For a generation
defect, make a targeted revision through the normal Skill flow and retain any
explicit user limits. Report unresolved defects or partial delivery accurately.

Provide the individual original files, a labeled set preview and a download
archive containing the deliverables. Verify the archive opens and contains the
expected images. Preserve original image resolution; describe any separate
resized exports accurately.
