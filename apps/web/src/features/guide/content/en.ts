import {
  cards,
  type GuideContent,
  list,
  note,
  p,
  prompt,
  shot,
  steps,
  table,
  tip,
  warn,
} from '../model'
import { GUIDE_PATHS } from '../paths'

const img = (name: string) => `/guide-assets/en/${name}.webp`

export const guideEn: GuideContent = {
  lang: 'en',
  path: GUIDE_PATHS.en,
  meta: {
    title: 'Muvloom user guide: AI images, canvas editing and agent',
    description:
      'The official Muvloom guide: text-to-image and image-to-image, reference images and inpainting, annotated canvas editing, the AI agent and its skills, assets and templates.',
    ogImageAlt: 'Muvloom user guide',
  },
  chrome: {
    brand: 'Muvloom',
    eyebrow: 'Help center',
    title: 'User guide',
    lead: 'From your first image to a complete product set: the core features of Muvloom and how to get the most out of them.',
    start: 'Start creating',
    toc: 'Contents',
    tipLabel: 'Tip',
    noteLabel: 'Note',
    warnLabel: 'Important',
    backToTop: 'Back to top',
    otherLanguage: '中文',
    updated: 'Updated',
  },
  sections: [
    {
      id: 'intro',
      title: 'Meet Muvloom',
      summary: 'What Muvloom does, its core capabilities and the interface layout.',
      subsections: [
        {
          id: 'what-is',
          title: 'What is Muvloom',
          blocks: [
            p(
              'Muvloom is a **browser-based AI image studio**. Describe a scene and it generates the image; continue editing the result on an infinite canvas, or let the AI agent write prompts, make targeted edits and produce complete asset sets.',
            ),
            p(
              'There is nothing to install and no design experience required. Muvloom covers product hero images, posters, social media visuals, character sheets and product scenes.',
            ),
          ],
        },
        {
          id: 'features',
          title: 'Core capabilities',
          blocks: [
            cards(
              {
                title: 'Text and image to image',
                text: 'Generate from a description or a reference image, several images per run.',
                href: '#create',
              },
              {
                title: 'Inpainting',
                text: 'Change only the selected area and keep the rest of the image intact.',
                href: '#mask-edit',
              },
              {
                title: 'Infinite canvas',
                text: 'Arrange, annotate and compare versions side by side.',
                href: '#canvas',
              },
              {
                title: 'AI agent',
                text: 'Writes the prompt for you and generates once you confirm; ships with e-commerce and marketing skills.',
                href: '#agent',
              },
              {
                title: 'Assets and templates',
                text: 'Keep the product shots and looks you use often, ready to reuse.',
                href: '#assets',
              },
              {
                title: 'Batch generation',
                text: 'Produce multiple variations in one run with slots or templates.',
                href: '#slots',
              },
            ),
          ],
        },
        {
          id: 'interface',
          title: 'Interface overview',
          blocks: [
            p('The home page is the [[Create]] page. It consists of the following areas:'),
            shot(
              img('home'),
              'Muvloom home page: sidebar navigation, the prompt box in the center, inspiration and works below',
              'The Create page',
              [
                { x: 2, y: 7.1 },
                { x: 48.9, y: 19.8 },
                { x: 27.4, y: 28.1 },
                { x: 40, y: 35.8 },
                { x: 50.8, y: 34.5 },
                { x: 78.6, y: 34.1 },
                { x: 23.6, y: 47.9 },
                { x: 18.5, y: 68.4 },
                { x: 93.9, y: 2.8 },
              ],
            ),
            steps(
              '**Sidebar**: the [[Create]], [[Explore]] and [[Assets]] entry points, followed by your recent canvas projects. On mobile these move to a bottom tab bar.',
              '**Mode**: [[Generate]] produces images directly; [[Canvas]] opens a new canvas project and passes your request to the AI agent.',
              '**Prompt box**: enter your prompt here. Use `@` to reference images and `{slot}` for batch generation.',
              '**Model**: the model used for generation.',
              '**Parameters**: [[Ratio]] (or [[Size]]) and [[Count]]; further options are under [[More]].',
              '**Generate**: submits the job. Shortcut: {{Enter}}.',
              '**Inspiration**: example prompts; click one to load its prompt and settings.',
              '**Works**: results appear under [[My works]]. Until you have any, [[Inspiration]] is shown instead.',
              '**Account**: sign-in, your credit balance (where enabled) and the account menu.',
            ),
          ],
        },
      ],
    },
    {
      id: 'quick-start',
      title: 'Getting started',
      summary: 'Generate your first image, then review, download and refine the result.',
      subsections: [
        {
          id: 'first-image',
          title: 'Generate your first image',
          blocks: [
            p(
              'On the home page, make sure [[Generate]] is selected above the prompt box, then describe the image, for example:',
            ),
            prompt(
              'Example prompt',
              'A matcha latte on a wooden bar counter, fine milk foam, fresh mint leaves beside it, soft afternoon light through the window, warm tones, commercial photography, 3:4 portrait',
            ),
            steps(
              'Set [[Ratio]] and [[Count]] as needed.',
              'Click [[Generate]] or press {{Enter}}.',
              'The job appears at the top of [[My works]], moving through [[Queued...]] and [[Generating...]] until the result is shown.',
            ),
            tip(
              'Press {{Shift}} + {{Enter}} for a new line. To use {{Enter}} for new lines instead, set the submit shortcut to {{Ctrl}} / {{⌘}} + {{Enter}} in settings.',
            ),
            note(
              'Built-in models require an account. If you are signed out, clicking [[Generate]] opens the sign-in dialog; your prompt and existing works are kept.',
            ),
          ],
        },
        {
          id: 'view-results',
          title: 'Review and download',
          blocks: [
            p('Each work card provides the following actions:'),
            table(
              ['Action', 'Description'],
              ['[[Add to favorites]]', 'Favorite the work; filter with [[Favorites only]].'],
              [
                '[[Reuse config]]',
                'Load the prompt, parameters and reference images back into the prompt box.',
              ],
              [
                '[[Edit output]]',
                'Use the result as a reference and open the mask editor for inpainting.',
              ],
              ['[[Send to canvas]]', 'Continue editing the image on a canvas.'],
              [
                '[[Download image]]',
                'Download the original file; works with several images download them all.',
              ],
              ['[[Delete record]]', 'Delete the work.'],
            ),
            p(
              'Click a card to open its details: the full-size image, prompt, reference images and parameters. Click the image for a fullscreen preview with zoom, and use {{←}} {{→}} to switch images.',
            ),
            tip('Right-click any image to [[Copy]], [[Download]], [[Edit]] or [[Save as asset]].'),
          ],
        },
        {
          id: 'keep-editing',
          title: 'Refine the result',
          blocks: [
            p('Choose an approach based on the scope of the change:'),
            table(
              ['Scope', 'Recommended approach'],
              [
                'Overall style or composition',
                'Click [[Reuse config]], adjust the prompt and regenerate.',
              ],
              [
                'A specific detail',
                'Click [[Edit output]], paint the area and describe the change. See [Inpainting](#mask-edit).',
              ],
              [
                'Comparing versions',
                'Click [[Send to canvas]], annotate the image and generate alongside it. See [Canvas](#canvas).',
              ],
              [
                'Hard to describe in words',
                'Let the [AI agent](#agent) interpret your request and write the prompt.',
              ],
            ),
          ],
        },
        {
          id: 'sign-in',
          title: 'Account and sync',
          blocks: [
            p(
              'You can browse and organize assets without an account. Generating with built-in models and opening cloud canvas projects require signing in.',
            ),
            p(
              'Works, assets and prompts created in this browser before signing in are **merged into your account on first sign-in**. Once signed in, works, assets, prompts, templates and canvas projects sync to the cloud and are available on any device.',
            ),
            note(
              'Interface language, theme and unsent prompts are stored in this browser only and are not synced.',
            ),
          ],
        },
      ],
    },
    {
      id: 'create',
      title: 'The Create page',
      summary: 'Prompts, reference images, batch generation, parameters and inpainting.',
      intro: [
        p(
          'The Create page is for generating images directly. This chapter covers every feature of the prompt box.',
        ),
      ],
      subsections: [
        {
          id: 'prompts',
          title: 'Writing prompts',
          blocks: [
            p('A prompt describes the image you want. A reliable structure is:'),
            prompt(
              'Prompt structure',
              'Image type + subject + setting + style + lighting and color + composition and ratio + on-image text',
            ),
            prompt(
              'Example',
              'E-commerce hero image for a new rose serum, a clear glass bottle with a gold cap centered in frame, surrounded by rose petals and water droplets, refined texture, pink and rose gold palette, soft studio lighting, headline text “GLOW SERUM”',
            ),
            list(
              '**Be specific**: “a ginger short-haired cat sunbathing on a windowsill” gets closer to what you want than “a cat”.',
              '**Quote on-image text**: text that must appear in the image is rendered more accurately in quotes.',
              '**Describe the style**: use concrete traits such as “minimal, generous white space, low saturation” rather than brand names.',
              '**Avoid conflicts**: for example, asking for both “minimal” and “richly detailed”.',
            ),
          ],
        },
        {
          id: 'reference-images',
          title: 'Reference images',
          blocks: [
            p(
              'Reference images keep a product, a person or a layout consistent across generations. Add them in any of these ways:',
            ),
            list(
              'Click the image button at the bottom left of the prompt box and choose files (multiple selection supported).',
              'Copy an image and paste it into the prompt box with {{Ctrl}} / {{⌘}} + {{V}}.',
              'Drag image files anywhere onto the page.',
            ),
            p(
              'Type `@` in the prompt to reference an image, which inserts a mention such as [[@Image 1]] — for example, “place the cup from @Image 1 on the table in @Image 2”. The `@` menu also lists your saved assets; choosing one adds all of its views.',
            ),
            p(
              'Drag thumbnails to reorder them. Right-click a thumbnail to [[Insert reference]] or [[Save as asset]].',
            ),
            warn(
              'Up to 16 reference images, 10MB each, in JPG, PNG or WebP. If the current model does not support reference images, the image button is disabled; switch to another model.',
            ),
          ],
        },
        {
          id: 'slots',
          title: 'Batch generation',
          blocks: [
            p(
              'Slots produce several variations in one submission, useful for comparing colors, styles or settings.',
            ),
            steps(
              'Define a slot with `{name}` in the prompt, for example “a {color} cat sitting in a {place}”. Names cannot contain spaces.',
              'Click the slot chip and enter one value per line, for example “ginger”, “black”, “white”.',
              'Click Generate. Each combination is generated once, and the button shows the total, such as [[Generate 6 images]].',
            ),
            warn(
              'Slot combinations × count cannot exceed 16 images. Every slot needs at least one value before you can submit.',
            ),
          ],
        },
        {
          id: 'models-params',
          title: 'Models and parameters',
          blocks: [
            table(
              ['Parameter', 'Description'],
              [
                'Model',
                'Models differ in style strengths and supported parameters; the default model suits most tasks.',
              ],
              ['[[Ratio]] / [[Size]]', 'Aspect ratio or exact resolution; see the next section.'],
              ['[[Count]]', 'Images per run, 1–10.'],
              ['[[Quality]]', 'auto / low / medium / high. Higher quality takes longer.'],
              ['[[Format]]', 'PNG / JPEG / WebP.'],
              ['[[Alpha]]', 'Available for PNG; generates a transparent background.'],
              [
                '[[Compression]]',
                'Available for JPEG and WebP; lower values produce smaller files.',
              ],
              [
                '[[No rewrite]]',
                'On by default; prevents intermediate services from rewriting your prompt.',
              ],
            ),
            shot(
              img('params-more'),
              'The More menu with quality, format, alpha and no-rewrite options',
              '[[More]] lists only the parameters the current model supports',
            ),
            note(
              'Gemini models use [[Ratio]], [[Resolution]] and [[Thinking]] in place of size and quality.',
            ),
          ],
        },
        {
          id: 'size',
          title: 'Size and aspect ratio',
          blocks: [
            p(
              'Click [[Ratio]] (or [[Size]]) to open the dialog. The available modes depend on the model:',
            ),
            list(
              '**[[Smart ratio (Auto)]]**: the model chooses the size. Shown as [[Auto]] in size mode.',
              '**[[By ratio]]**: choose a common ratio such as 1:1, 3:4 or 16:9, or enter any value with [[Custom ratio]]. Models that support exact resolutions also offer a [[Base resolution]] of 1K, 2K or 4K.',
              '**[[Custom size]]**: enter width and height in pixels. Available only for models that support exact sizes.',
            ),
            shot(
              img('size-picker'),
              'The aspect ratio dialog with common ratios listed under By ratio',
              'Aspect ratio settings',
            ),
            table(
              ['Use case', 'Recommended ratio'],
              ['Product hero images, avatars', '1:1'],
              ['Social covers, posters, phone wallpapers', '3:4, 2:3, 9:16'],
              ['Article headers, web banners, video thumbnails', '16:9, 21:9'],
            ),
            note(
              'Width and height must be multiples of 16, with a longest side of 3840 px and an aspect ratio within 3:1. Other sizes are adjusted automatically.',
            ),
          ],
        },
        {
          id: 'mask-edit',
          title: 'Inpainting',
          blocks: [
            p(
              'Inpainting changes only the area you paint, for tasks such as changing a color, removing an object or replacing an element.',
            ),
            steps(
              'Click [[Edit output]] on a work card, click the brush icon on a reference thumbnail, or right-click an image and choose [[Edit]].',
              'In the editor, outline an area with [[Lasso]] or brush it with [[Paint]]; use [[Erase]] to refine the selection. The blue overlay marks the area to change.',
              'Click [[Save]]. The image moves to the first reference slot with a MASK badge, and the submit button changes to [[Edit mask]].',
              'Describe the change in the prompt, for example “replace the cup with a pink ceramic mug”, then click [[Edit mask]].',
            ),
            warn(
              'Only one mask image is supported per submission, and a selection is required before submitting.',
            ),
          ],
        },
        {
          id: 'saved-prompts',
          title: 'Reusing prompts and templates',
          blocks: [
            table(
              ['Type', 'How to save', 'How to use'],
              [
                'Saved prompt',
                'Click the bookmark button [[Save as template]] in the prompt box; referenced assets and parameters are saved with it.',
                'Type `/` in the prompt box, or apply it from [[Assets]] → [[Prompts]].',
              ],
              [
                'Template',
                'Create one under [[Assets]] → [[Templates]], or use a built-in template.',
                'Click a template below the prompt box to switch model and size, then attach product assets with `@`.',
              ],
            ),
            note(
              '[[Save as template]] stores prompts under [[Assets]] → [[Prompts]]. [[Assets]] → [[Templates]] holds tuned looks, which serve a different purpose.',
            ),
          ],
        },
        {
          id: 'my-works',
          title: 'Managing works',
          blocks: [
            list(
              '**Filter**: use [[Favorites only]], the status filter ([[Completed]], [[Generating]], [[Failed]]) or keyword search.',
              '**Bulk actions**: hold {{Ctrl}} / {{⌘}} and click cards, or drag a selection box over empty space; on mobile, swipe a card sideways. Selected works can be favorited, downloaded or deleted together.',
              '**Failures**: open the details to see the cause. If content review rejected the prompt, click [[Edit the prompt]] to revise it; otherwise click [[Retry task]].',
              '**Background processing**: jobs on built-in models run on the server and resume automatically after you close or refresh the page.',
            ),
          ],
        },
      ],
    },
    {
      id: 'canvas',
      title: 'Canvas',
      summary: 'Arrange, annotate, edit and export images on an infinite canvas.',
      intro: [
        p(
          'The canvas is a workspace you can pan and zoom freely. Arrange several images together, annotate where changes are needed, and each new result is placed beside its source for easy comparison.',
        ),
      ],
      subsections: [
        {
          id: 'canvas-projects',
          title: 'Create and open a canvas',
          blocks: [
            list(
              'On the home page, switch to [[Canvas]], describe your request and click [[Start creating]]. A new canvas project opens and the AI agent takes over.',
              'In the sidebar, click [[＋]] next to Canvases to create a canvas, or [[All]] to see every project.',
              'Recent canvases are listed in the sidebar; click ↗ ([[Open immersive]]) to open one with the sidebar collapsed.',
              'Click [[Send to canvas]] on a work card to add the image to the current canvas.',
            ),
            p('Canvases save automatically and sync to the cloud once you are signed in.'),
          ],
        },
        {
          id: 'canvas-basics',
          title: 'Basics',
          blocks: [
            shot(
              img('canvas'),
              'Canvas: chat panel on the left, toolbar, an annotated image and the image toolbar',
              'The canvas',
              [
                { x: 2.2, y: 7.2 },
                { x: 2.8, y: 79.6 },
                { x: 27.6, y: 33.9 },
                { x: 45.2, y: 59.2 },
                { x: 30.5, y: 63.8 },
              ],
            ),
            steps(
              '**Chat panel**: talk to the AI agent; [[Creations]] lists everything on the canvas.',
              '**Agent input**: describe your request; use `@` to reference canvas images or assets.',
              '**Toolbar**: select, hand, pen, eraser, arrow and text, plus undo, redo and zoom.',
              '**Annotations**: mark what to change and how, with the pen, arrows and text.',
              '**Image toolbar**: shown when a single image is selected; provides inpainting, erase, cut-out and more.',
            ),
            p(
              'Add images with [[＋ Import reference images]] on an empty canvas, by dragging files in, or by pasting. Scroll to pan; {{Ctrl}} / {{⌘}} + scroll to zoom.',
            ),
            table(
              ['Action', 'Shortcut'],
              ['Select / Hand', '{{V}} / {{H}}'],
              ['Pen / Eraser', '{{D}} / {{E}}'],
              ['Arrow / Text', '{{A}} / {{T}}'],
              ['Undo / Redo', '{{⌘}}{{Z}} / {{⌘}}{{⇧}}{{Z}}'],
              ['Copy / Paste / Duplicate', '{{⌘}}{{C}} / {{⌘}}{{V}} / {{⌘}}{{D}}'],
              ['Select all / Add to selection', '{{⌘}}{{A}} / {{Shift}} + click'],
              ['Delete', '{{Delete}}'],
              ['Temporary pan', 'Hold {{Space}} and drag'],
              ['Drag without snapping', 'Hold {{⌥}} while dragging'],
              ['Deselect', '{{Esc}}'],
            ),
            note(
              'On Windows, use {{Ctrl}} for {{⌘}} and {{Alt}} for {{⌥}}. Canvas shortcuts are inactive while a text field has focus.',
            ),
          ],
        },
        {
          id: 'canvas-annotate',
          title: 'Annotate changes',
          blocks: [
            p('Annotations let you point to exactly where and what to change.'),
            steps(
              'Press {{D}} for the pen and circle the area to change.',
              'Press {{A}} to add an arrow and {{T}} to add a note, such as “add gold leaf”.',
              'Press {{V}} to return to the select tool and select the image; annotations on top of it are included automatically.',
              'Describe the change in the chat panel. The new result is placed to the right of the original.',
            ),
            p(
              'Use the style panel in the top-right corner to change annotation color, stroke width and font size.',
            ),
            warn(
              'The toolbar eraser deletes any element it touches, including images (undo with {{⌘}}{{Z}}). To remove an object inside an image, use [[Erase]] on the image toolbar.',
            ),
          ],
        },
        {
          id: 'canvas-image-actions',
          title: 'Image editing',
          blocks: [
            p('Selecting a single image shows the image toolbar:'),
            table(
              ['Tool', 'Description'],
              [
                '[[Inpaint]]',
                'Paint an area and describe the change; only that area is regenerated.',
              ],
              [
                '[[Erase]]',
                'Paint over content to remove; the background is filled in automatically.',
              ],
              ['[[Cut out]]', 'Remove the background and export a transparent PNG.'],
              ['[[Regenerate]]', 'Generate again with the same settings.'],
              ['[[Crop]]', 'Drag the frame to crop. Runs locally and uses no credits.'],
              [
                '[[Expand]]',
                'Drag the frame outward to extend the image; optionally describe the new area.',
              ],
              ['[[More]]', 'View original, copy, download and delete.'],
            ),
            shot(
              img('canvas-inpaint'),
              'Inpainting: painting the area to change, with the description panel below',
              'Inpainting',
            ),
            note(
              'Inpaint, erase, cut-out and expand replace the original image; undo with {{⌘}}{{Z}}. Inpaint, erase and expand require a model with mask support (GPT Image family); hover a disabled button to see why.',
            ),
          ],
        },
        {
          id: 'canvas-export',
          title: 'Batch actions and export',
          blocks: [
            list(
              'Drag a selection box or {{Shift}}-click multiple elements to show the batch bar.',
              '[[Batch generate N]]: apply one description to every selected image, with each result placed beside its source. Useful for bringing a product set into one style.',
              '[[Export N]]: a single item downloads directly; multiple items are packaged as a ZIP.',
              'Right-click an image and choose [[Download image]] to download the original.',
            ),
          ],
        },
      ],
    },
    {
      id: 'agent',
      title: 'AI agent',
      summary:
        'Describe what you need; the agent writes the prompt and generates after you confirm.',
      intro: [
        p(
          'The chat panel on the left of the canvas is the AI agent. It reads the canvas, chooses an approach and writes the prompt, and **generates only after you confirm** — ideal if you are new to writing prompts.',
        ),
      ],
      subsections: [
        {
          id: 'agent-chat',
          title: 'Start a conversation',
          blocks: [
            steps(
              'Open a canvas and describe your request in the input on the left, for example “design a Valentine’s Day poster for this perfume”.',
              'Add reference images with the paperclip or by dragging them in; images selected on the canvas, with their annotations, are included automatically.',
              'Press {{Enter}}. The agent analyzes the request and the canvas, then proposes a prompt draft.',
            ),
            list(
              'Type `@` to reference this turn’s images, canvas images or assets.',
              'Click [[Stop]] to interrupt a reply; messages sent meanwhile are queued and processed in order.',
              'Use the generation settings below the input to adjust [[Thinking depth]], model and size.',
            ),
            note(
              'Each turn accepts up to 8 reference images. The agent uses built-in models only.',
            ),
          ],
        },
        {
          id: 'agent-drafts',
          title: 'Confirm and generate',
          blocks: [
            steps(
              'When the prompt is ready, the agent shows a draft card.',
              'Review the prompt, model and image count; you can edit them directly on the card.',
              'Click [[Confirm and generate]]. Results are placed on the canvas; click a thumbnail to locate it.',
            ),
            p('When several drafts are pending, click [[Confirm all]] to submit them together.'),
            tip(
              'With ⚡ [[Direct generation mode]] on, the agent generates as soon as the prompt is ready, without waiting for confirmation. Credits are consumed immediately.',
            ),
          ],
        },
        {
          id: 'agent-skills',
          title: 'Skills',
          blocks: [
            p(
              'Skills are specialized workflows for specific tasks. Type `/` at the **start** of the input to choose one:',
            ),
            table(
              ['Skill', 'Use case'],
              ['Product hero image', 'Marketplace hero images, on white or in a scene'],
              [
                'Product image set',
                'A complete detail-page set: hero, selling points, close-ups and scenes',
              ],
              ['Posters and marketing', 'Posters and campaign key visuals with headline copy'],
              ['Scene swap', 'Keep the subject unchanged and replace only the background'],
              [
                'Product restyle',
                'Swap the product or change color and material while keeping background and lighting',
              ],
              ['Viral image remix', 'Recreate a proven design with your own product'],
              [
                'Image localization',
                'Translate on-image text into another language while keeping the layout',
              ],
              [
                'Character sheet',
                'A reusable character reference that keeps later images consistent',
              ],
              ['Reverse prompt', 'Derive a reproducible prompt from a reference image'],
              [
                'Create asset / template',
                'Turn images into an asset, or save a look as a template',
              ],
            ),
          ],
        },
        {
          id: 'agent-tips',
          title: 'Best practices',
          blocks: [
            list(
              '**State the use case**: mention where the image will be used, such as “Amazon listing” or “Instagram post”, so the agent can choose the right format and style.',
              '**Iterate step by step**: settle the overall style first, then refine details.',
              '**Combine references and annotations**: marking the area directly is more precise than describing it.',
              '**Answer clarifying questions**: pick one of the suggested options, or choose [[Other…]] to write your own.',
            ),
          ],
        },
      ],
    },
    {
      id: 'assets',
      title: 'Assets',
      summary: 'Manage canvas projects, assets, saved prompts and templates.',
      intro: [
        p(
          'Click [[Assets]] in the sidebar to open the Assets page, which has four tabs: [[Projects]], [[Assets]], [[Prompts]] and [[Templates]].',
        ),
      ],
      subsections: [
        {
          id: 'assets-projects',
          title: 'Projects',
          blocks: [
            p(
              'All canvas projects in one place, with search, rename and delete. With cloud sync on, deleted projects go to the trash first and can be restored during the retention period.',
            ),
          ],
        },
        {
          id: 'assets-materials',
          title: 'Assets',
          blocks: [
            p(
              'An asset is a group of images of one subject, such as a product’s front, side and detail shots, or several photos of the same person. Saved assets can be added as references in one click.',
            ),
            steps(
              'Click [[New asset]] and drag in one or more images of the same subject.',
              'Enter a name (up to 20 characters), choose Product or Person, and click [[Save]].',
            ),
            list(
              'Alternatively, right-click a reference thumbnail and choose [[Save as asset]], or drag images directly onto the [[Assets]] tab.',
              'To use an asset, click [[Add reference]] on its card, or type `@` in the prompt box and select it.',
            ),
          ],
        },
        {
          id: 'assets-prompts',
          title: 'Prompts',
          blocks: [
            p(
              'Prompts saved with [[Save as template]], together with their referenced assets and parameters. Click [[Apply]] to load one into the prompt box, or type `/` in the prompt box to search.',
            ),
          ],
        },
        {
          id: 'assets-looks',
          title: 'Templates',
          blocks: [
            p(
              'A template captures a tuned look — lighting, setting and layout. Apply your product assets to a template to generate a batch of images in a consistent style.',
            ),
            shot(
              img('assets-looks'),
              'The Templates tab on the Assets page with built-in templates',
              'The Templates tab',
            ),
            list(
              '**Built-in templates**: ready to use. To adjust one, click [[Copy and edit]].',
              '**New template**: upload a reference poster or shot, name it and choose a purpose (hero, poster, scene or detail). The agent can also create one for you.',
              '**Batch generation**: click [[Generate with it]], select Product or Person assets, set the images per asset and submit.',
            ),
            note(
              '[[Generate with it]] and [[Keep tuning]] require signing in with cloud sync enabled. Templates whose model has been retired show [[Needs retuning]].',
            ),
          ],
        },
      ],
    },
  ],
  faq: {
    id: 'faq',
    title: 'FAQ',
    items: [
      {
        q: 'Clicking Generate opened a sign-in dialog instead of generating. Why?',
        a: 'Built-in models require an account. After you sign in, the page reloads with your prompt and works intact; click Generate again.',
      },
      {
        q: 'Why is the reference image button disabled?',
        a: 'The current model does not support reference images. Switch to a model that supports image-to-image. Up to 16 reference images are allowed, 10MB each.',
      },
      {
        q: 'Why are transparent background or compression missing from More?',
        a: 'Available options depend on the model and format: transparency requires PNG, compression requires JPEG or WebP, and Gemini models expose a different set of parameters.',
      },
      {
        q: 'What does “at most 16 images per submission” mean?',
        a: 'Slot combinations multiplied by the count exceed 16. Reduce slot values or the count, and generate in several runs.',
      },
      {
        q: 'Why are Inpaint, Erase and Expand disabled?',
        a: 'They require a model with mask support (GPT Image family), and the image cannot be too small or too elongated. Hover the button to see the exact reason.',
      },
      {
        q: 'I messaged the agent but no image was generated. Why?',
        a: 'The agent prepares a prompt draft first and waits for you to click Confirm and generate. Direct generation mode skips confirmation but consumes credits immediately.',
      },
      {
        q: 'An image on the canvas was deleted by the eraser. How do I restore it?',
        a: 'The toolbar eraser deletes any element it touches; press Ctrl/⌘ + Z to undo. To remove an object inside an image, select the image and use Erase on the image toolbar.',
      },
      {
        q: 'Where does Save as template store my prompt?',
        a: 'In the Prompts tab on the Assets page; you can also type / in the prompt box to use it. The Templates tab holds tuned looks, which serve a different purpose.',
      },
      {
        q: 'Generation failed content review. What should I do?',
        a: 'Retrying the same prompt will fail again. Open the work details, click Edit the prompt and revise the description.',
      },
      {
        q: 'Do running jobs stop if I close the page?',
        a: 'Jobs on built-in models run on the server and resume automatically when you return.',
      },
      {
        q: 'Can I see my works on another device?',
        a: 'Sign in with the same account to access works, assets, prompts, templates and canvas projects synced to the cloud. Data created before signing in is merged into your account on first sign-in.',
      },
    ],
  },
}
