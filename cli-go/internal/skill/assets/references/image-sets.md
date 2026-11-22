# Coordinated image sets & e-commerce galleries

Use for e-commerce listing galleries (main/hero images, white-background shots, feature callouts, lifestyle scenes, scale/dimension views, in-box contents, detail-page banners) and other multi-image sets. Preserve the requested platform, count, and purpose.

## Confirmation policy: 1–3 images vs 4+ images

- **1–3 images** (or when the user explicitly says to generate directly / skip confirmation): state the chosen roles briefly as a progress note and proceed directly to generation without an approval gate.
- **4+ images** (including unspecified full e-commerce sets, where **6 slots** is the default when 4–8 fits the product): **planning is zero-cost — present ONE structured shot-plan & credit-estimate confirmation card and wait for the user's go-ahead before the first `muvloom images create`**.
- **Pending login synergy (`AUTH_PENDING`)**: if first-time browser authorization is still waiting for approval when the user asked for a 4+ image set, deliver the SKU fact card and draft ordered shot plan in the same reply so the wait produces immediate value; once approved, run `muvloom capabilities` and `muvloom images validate` to attach live credit quotes.

## 1. Build the SKU fact card & handle variants

Before writing prompts, inspect the supplied product reference photos and separate **verified product facts** from creative styling:

- **Verified facts**: exact SKU/model and lead variant, visible must-keeps (silhouette, color, texture, logo/maker's mark, ports/fittings), confirmed benefits/claims, dimensions/scale facts, confirmed in-box items, and target storefront (Taobao/Tmall, JD, Pinduoduo, Douyin, Amazon, Shopify, etc.).
- **No fabricated claims**: never invent dimensions, materials, certifications, performance numbers, or extra accessories not supported by the user's photos or text. Prefer carrying an approved benefit visually through composition (e.g. steam rising during pour-over) rather than small baked-in body copy, unless headline text was requested.
- **One SKU per gallery**: when a product has color/size/material variants, the variant in the supplied photo leads unless the user says otherwise (ask which leads only if a photo shows multiple variants without specifying). Add a multi-variant range slot only when the user provides a single photo genuinely showing those variants together — never stitch separate single-SKU photos and present them as a range shot. For separate variant listings, run one gallery per SKU reusing the slot template and shared direction clause, never sharing another SKU's fact card or photos.

Adapt 4–8 ordered slots to the product and available facts (default 6 slots when unspecified, skipping roles whose facts are absent rather than padding):

| Slot | Buyer question | Required source | Default ratio |
| --- | --- | --- | --- |
| 1. Product hero / clean view | What is the exact SKU? | Primary product photo + SKU identity | `1:1` |
| 2. Primary feature | Which verified benefit stands out first? | Approved benefit + visible product detail | `1:1` |
| 3. Craft / secondary view | How does the material, mechanism, or finish look up close? | Verified detail + product reference | `1:1` |
| 4. Lifestyle / usage scene | Where and how is it used in context? | Approved use context + product as focal point | `3:4` (or `1:1`) |
| 5. Scale / fit / dimensions | How big is it in real life? | Confirmed dimensions or scale anchor | `1:1` |
| 6. In-box / detail banner | What arrives in the box (or campaign header)? | Confirmed package list (or approved campaign theme) | `1:1` (`16:9` for banner) |

## 2. Write cohesive prompts with a verbatim shared direction

Slot prompts differ by role and agree on everything else. Structure every slot prompt in four parts, in order:

1. **Slot role and purpose** (e.g. clean product hero, close material detail, contextual kitchen counter scene).
2. **SKU identity anchor**: state explicitly that reference image 1 (`--ref`) is the exact verified SKU.
3. **Slot must-keeps & verified fact** for this specific shot.
4. **One shared visual direction clause**, reused **verbatim** across every slot in the set (surface, light direction and quality, depth of field, color palette, camera style). Varying the wording of this clause across slots is the main cause of inconsistent galleries.

Restate negative directions positively before putting them into the shared clause (e.g. turn "no messy props" into "the product alone on a clean warm-neutral stone surface"). The sole exception is an enumerated in-box/package contents slot, which should state an explicit bound ("nothing else") so extra accessories are not hallucinated.

## 3. Price via `muvloom images validate` & confirm once (4+ images)

Before the first paid `images create` on a 4+ image set:

1. Read `credits` (and `unmetered` when present) from `muvloom auth status`, plus `default_model` / `models` / `limits.concurrent_jobs` from `muvloom capabilities`.
2. Run zero-cost `muvloom images validate --prompt "slot quote" [exact model, --ref, ratio, size, quality, output-format, --frames/--frame-size flags]` once for each distinct parameter combination in the set (including the slot's actual `--ref` files — `/v1/media` deduplicates uploads by SHA-256 at zero credit cost, and models such as Image 2.6 price reference-image edits and GIF frame counts differently from text-to-image, while also validating `edit` support and `max_reference_images` upfront). Never guess or reuse stale prices.
3. Present **one concise confirmation card** in the user's language containing:
   - **Ordered slot table**: `#`, Role, Buyer question / visual focus, Verified fact & `--ref` order (verified primary SKU photo always first), Canvas (`aspect_ratio` · `image_size`), and `Estimated credits` (omit credit columns and balance comparison when `quote` or `credits` is `null`/`none`, such as unmetered enterprise accounts or deployments with credit billing disabled).
   - **Shared visual direction** (one short block) and **model** (`count: 1` per call).
   - **Cost & concurrency summary**: total calls (`N`), **estimated total credits** vs **current balance** (`credits` — when both are numeric and `credits < estimated total`, warn clearly upfront and mention `/pricing`), and in-flight concurrency (`limits.concurrent_jobs`).
   - **Mid-run & recovery guarantee**: nothing is charged until approved; stopping after any slot keeps all completed images (locally and synced to Muvloom Web **Assets → Works / 资产 → 作品**), while remaining frozen slots stay uncharged and resumable under their original `idempotency_key`s. Changing a slot's prompt, fact, `--ref` order, canvas, or model after approval is new paid work with a fresh `idempotency_key`.

## 4. Freeze, generate concurrently, and halt on balance/quota limits

Once approved (or immediately for 1–3 image requests):

- Pass `--aspect-ratio` explicitly per slot (`1:1`, `3:4`, `16:9`, etc. when supported; prompt text alone does not set output dimensions) and `--image-size` (`2K` for hero/scene shots when supported, `4K` only when requested or needed and permitted by membership).
- Assign one stable, unique `--idempotency-key` per slot before submission and keep a local slot manifest (`slot`, `role`, `flags`, `idempotency_key`, `job_id`, `artifact_id`, `local_path`, `actual_credits`).
- Respect `capabilities.limits.concurrent_jobs`: when `concurrent_jobs > 1` (e.g. 2 or 3), keep up to that many jobs in flight at once (submit without `--wait` or in parallel, then `muvloom jobs wait` and `muvloom artifacts download`) rather than forcing slow serial execution.
- **Batch circuit breaker (`INSUFFICIENT_CREDITS` / `QUOTA_EXCEEDED`)**: if any slot fails with `INSUFFICIENT_CREDITS` or `QUOTA_EXCEEDED` (exit code 5), **stop submitting all remaining unsubmitted slots immediately**. Report which slots completed, which slots remain frozen, and relay `details.top_up_url` + `details.account` (or `details.reset_at`). Resume only the unfinished slots using their original `idempotency_key`s after the user confirms they have topped up (or re-quote with new keys if the user chooses a cheaper model/tier).

## 5. Inspect, deliver, and link to Web canvas

Inspect every downloaded image individually:

- Verify requested count, actual pixel dimensions, and aspect ratios.
- Check SKU silhouette, color, label/markings, fittings, and surface fidelity against the original product reference and across all slots.
- Verify visible copy character-by-character for spelling and legibility, and confirm no unapproved claims or extra in-box items appeared.

Fix local packaging issues without regenerating. For a generation defect or user-requested tweak to a single slot, submit a targeted revision for just that slot with a new `idempotency_key` (passing the accepted slot image + original SKU reference when refining), preserving any explicit credit limit.

Deliver the ordered files, per-slot observed dimensions and `actual_credits`, and a labeled preview or archive when helpful. Mention that every generated image is also synced to **Muvloom Web → Assets → Works (资产 → 作品)**, where the user can open a work, click **Add to canvas / 放入画布**, and use **Smart edit / 智能改图**, **Erase / 擦除**, **Cut out / 抠图**, **Expand / 扩图**, or **Crop / 裁剪**.
