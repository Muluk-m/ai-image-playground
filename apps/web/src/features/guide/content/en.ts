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
    title: 'Muvloom user guide: AI image generation, canvas editing, agent',
    description:
      'Beginner tutorial for Muvloom: AI image generation from one sentence, reference images and inpainting, canvas editing with annotations, and AI agent skills.',
    ogImageAlt: 'Muvloom user guide',
  },
  chrome: {
    brand: 'Muvloom',
    eyebrow: 'Help center',
    title: 'User guide',
    lead: 'First time in Muvloom? Start with “Five-minute start” and you will have your first image by the end of it; after that jump to whatever you need. Anything printed as [[a label like this]] is the exact wording on screen, so you can look for it.',
    start: 'Start creating',
    toc: 'Contents',
    tipLabel: 'Tip',
    noteLabel: 'Note',
    warnLabel: 'Heads-up',
    backToTop: 'Back to top',
    otherLanguage: '中文',
    updated: 'Updated',
  },
  quickStart: {
    title: 'Three steps to your first image',
    items: [
      {
        title: 'Write a line, get your first image',
        text: 'Describe the picture in the home input box and click [[Generate]].',
        href: '#first-image',
      },
      {
        title: 'Put it on the canvas and keep editing',
        text: 'Circle what should change and let the agent redo it.',
        href: '#canvas-annotate',
      },
      {
        title: 'Save and download',
        text: 'Favorite it, download it, or keep it as an asset or template to reuse.',
        href: '#view-results',
      },
    ],
  },
  sections: [
    {
      id: 'intro',
      title: '1. Meet Muvloom',
      subsections: [
        {
          id: 'what-is',
          title: '1.1 What Muvloom is',
          blocks: [
            p(
              'Muvloom is an **AI image and video studio that runs in your browser**. Describe the picture you want in one sentence and it generates the image; then keep editing it on an infinite canvas, or hand it to the AI agent so it drafts the prompt, reworks the image and produces a whole set of assets.',
            ),
            p(
              'Nothing to install, no design background needed. Product hero images, posters, social media visuals, character sheets, product scene shots — every one of them starts from a sentence.',
            ),
          ],
        },
        {
          id: 'features',
          title: '1.2 What you can do with it',
          blocks: [
            cards(
              {
                title: 'One line, one image',
                text: 'Describe the picture, pick a model and a ratio, get several images in one run.',
                href: '#create',
              },
              {
                title: 'Reference images and inpainting',
                text: 'Upload references for image-to-image, and repaint only the part you paint over.',
                href: '#mask-edit',
              },
              {
                title: 'Infinite canvas',
                text: 'Lay images out, circle things, write notes, and generate new versions beside the original.',
                href: '#canvas',
              },
              {
                title: 'AI agent',
                text: 'It writes the prompt first and generates after you confirm; built-in skills for e-commerce, posters and more.',
                href: '#agent',
              },
              {
                title: 'Video',
                text: 'Make an image move, extend it, edit it, and cut the clips into a film.',
                href: '#video',
              },
              {
                title: 'Inspiration, assets and templates',
                text: 'Borrow good prompts from others, and keep the images and looks you use often.',
                href: '#explore',
              },
            ),
          ],
        },
        {
          id: 'interface',
          title: '1.3 A tour of the interface',
          blocks: [
            p('Open the Muvloom home page (the [[Create]] page) and you will see these areas:'),
            shot(
              img('home'),
              'Muvloom home page: sidebar navigation, the input box in the middle, inspiration and works below',
              'Home page (Create)',
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
              '**Sidebar**: the three entry points [[Create]], [[Explore]] and [[Assets]], with [[Canvases]] below them listing your recent canvas projects. On a phone they sit at the bottom of the screen.',
              '**Generate / Canvas switch**: [[Generate]] makes the image right away; [[Canvas]] opens a new canvas and hands your sentence to the AI agent.',
              '**Input box**: where the prompt goes. Use `@` to reference an image and `{slot}` to batch generate.',
              '**Model**: open the dropdown to choose which model generates the image.',
              '**Parameters**: [[Ratio]] (or [[Size]]) and [[Count]]; everything else is tucked under [[More]].',
              '**Generate button**: click it to start, or simply press {{Enter}}.',
              '**Inspiration chips**: randomly suggested examples; one click drops their prompt and parameters into the input box.',
              '**Works area**: everything you generate lives under [[My works]]; until you have anything, [[Inspiration]] is shown here instead.',
              '**Account area**: signing in, credits (on sites that have them) and your personal menu are all in the top right.',
            ),
          ],
        },
      ],
    },
    {
      id: 'quick-start',
      title: '2. Five-minute start',
      subsections: [
        {
          id: 'first-image',
          title: '2.1 Generating your first image',
          blocks: [
            steps(
              'Open the Muvloom home page and make sure [[Generate]] is selected above the input box.',
              'Describe the picture you want in the input box, the more specific the better. For example:',
            ),
            prompt(
              'Example prompt',
              'A refreshing matcha latte on a wooden bar counter, silky fine milk foam, a few fresh mint leaves beside it, afternoon sunlight through the window, warm tones, commercial photography, 3:4 vertical composition',
            ),
            steps(
              '(Optional) Click [[Ratio]] to choose an aspect ratio and [[Count]] to set how many images you want.',
              'Click [[Generate]] on the right, or simply press {{Enter}}.',
              'A new work card appears at the top of [[My works]] below, showing [[Queued...]] and then [[Generating...]]; the image arrives on its own.',
            ),
            tip(
              'Need a line break mid-sentence? Press {{Shift}} + {{Enter}}. If you would rather have {{Enter}} insert the break, change the submit shortcut in settings to {{Ctrl}} / {{⌘}} + {{Enter}}.',
            ),
            note(
              'Generating with the built-in models requires an account. Clicking [[Generate]] while signed out opens the sign-in dialog; the page reloads afterward and your text and earlier works are still there.',
            ),
          ],
        },
        {
          id: 'view-results',
          title: '2.2 Viewing, downloading and favoriting',
          blocks: [
            p('Every work card has a row of buttons underneath, from left to right:'),
            table(
              ['Button', 'What it does'],
              [
                '[[Add to favorites]]',
                'Favorites this record; the star button [[Favorites only]] brings it back in one click.',
              ],
              [
                '[[Reuse config]]',
                'Puts this prompt, its parameters and its reference images back in the input box so you can tweak and rerun.',
              ],
              [
                '[[Edit output]]',
                'Uses the generated image as a reference and opens the mask editor for inpainting.',
              ],
              ['[[Send to canvas]]', 'Takes the image to a canvas to keep working on it.'],
              [
                '[[Download image]]',
                'Downloads the original file. When a record holds several images, all of them are downloaded.',
              ],
              ['[[Delete record]]', 'Deletes this record.'],
            ),
            p(
              'Clicking the card itself opens the details: the large image, the full prompt, the reference images and the parameters, and you can copy the prompt from there. Click the large image for fullscreen, zoom with the wheel or two fingers, and move between images with {{←}} {{→}}.',
            ),
            tip(
              'Right-click any image to [[Copy]], [[Download]], [[Edit]] or [[Save as asset]] straight away.',
            ),
          ],
        },
        {
          id: 'keep-editing',
          title: '2.3 Not happy? Keep editing',
          blocks: [
            p(
              'AI images usually take a few rounds. Pick the route that matches the size of the change:',
            ),
            list(
              '**The whole direction is off**: click [[Reuse config]], adjust the style, composition or color wording in the prompt and generate again.',
              '**Mostly right, one spot is wrong**: click [[Edit output]], paint that spot and spell out what it should become. See [Inpainting](#mask-edit).',
              '**You want to compare versions as you go**: click [[Send to canvas]], circle what should change and generate new versions beside it. See [Canvas](#canvas).',
              '**You cannot put it into words**: hand it to the [AI agent](#agent) — say what you need in plain language and it writes the prompt for you.',
            ),
          ],
        },
        {
          id: 'sign-in',
          title: '2.4 Signing in and keeping your work',
          blocks: [
            p(
              'You can open Muvloom, browse inspiration and organize assets without an account. Signing in is needed for: generating images or videos with the built-in models, opening cloud canvas projects, and using the agent to create assets and templates in bulk.',
            ),
            p(
              'Works, assets and prompts made in this browser before you sign in are **merged into your account the first time you sign in**, with a “Recovered N items from before you signed in” message. After that, works, assets, prompts, templates and canvas projects are saved to the cloud, so the same account shows them on another device.',
            ),
            warn(
              'API keys, unsent drafts in the input box, the interface language and the theme stay in this browser only and are never synced.',
            ),
          ],
        },
      ],
    },
    {
      id: 'create',
      title: '3. The Create page: one line, one image',
      intro: [
        p(
          'The Create page is the home page, and it is built for “write a line, get an image”. This chapter goes through every button in the input box.',
        ),
      ],
      subsections: [
        {
          id: 'prompts',
          title: '3.1 Writing a good prompt',
          blocks: [
            p('A prompt is your description of the picture. One structure that works well:'),
            prompt(
              'Universal formula',
              'Image type + subject + scene and environment + style + light and color + composition and ratio + text that has to appear',
            ),
            prompt(
              'Example',
              'An e-commerce hero image for a new rose serum, a clear glass bottle with a gold cap in the center of the frame, rose petals and water droplets around it, refined premium texture, pink and rose gold palette, soft studio light, the headline reads “GLOW SERUM”',
            ),
            list(
              '**The more specific the better**: “a cat” is weaker than “a ginger short-haired cat lying on a windowsill in the sun”.',
              '**Put text that has to appear in quotes** — models write it far more accurately that way.',
              '**Describe the style instead of naming a brand**: “minimal, lots of white space, low saturation” works better than “like brand X”.',
              '**Do not ask for contradictions**, such as “minimal” and “packed with elements” in the same prompt.',
            ),
            p('The × in the top right of the input box is [[Clear prompt]].'),
          ],
        },
        {
          id: 'reference-images',
          title: '3.2 Reference images and @ mentions',
          blocks: [
            p(
              'With a reference image the model follows it, which is how you keep a product, a face or a layout consistent. There are three ways to add one:',
            ),
            steps(
              'Click the image button at the bottom left of the input box and pick images from your device (several at once is fine).',
              'Copy an image, then press {{Ctrl}} / {{⌘}} + {{V}} in the input box to paste it.',
              'Drag image files anywhere onto the page and drop them when you see “Drop to add reference images”.',
            ),
            p(
              'Reference images show as a row of thumbnails numbered in the bottom left corner. Typing `@` in the prompt opens a menu, and picking an image inserts a mention such as [[@Image 1]] — for example “put the cup from @Image 1 on the table in @Image 2”.',
            ),
            list(
              'Drag a thumbnail to reorder it; hover it and click the × in the corner to remove it.',
              'Right-click a thumbnail (long-press on a phone) to [[Insert reference]] or [[Save as asset]].',
              'The `@` menu also lists the assets you saved, and picking one brings in every view of that asset.',
            ),
            warn(
              'Up to 16 reference images, 10MB each, in JPG, PNG or WebP. When the current model has no reference support the image button is grayed out — switch to another model.',
            ),
          ],
        },
        {
          id: 'slots',
          title: '3.3 Batch generating with {slot}',
          blocks: [
            p(
              'Want to try several colors, styles or scenes in one go? Write a “slot” in curly braces:',
            ),
            steps(
              'Write `{name}` in the prompt, for example “a {color} cat sitting in a {place}”. The name cannot contain spaces.',
              'It turns into a chip you can click; open it and type **one value per line**, such as “ginger”, “black”, “white”.',
              'Click [[Generate]]. Every combination is generated once and the button shows the total, for example [[Generate 6 images]].',
            ),
            warn(
              'Slot combinations × count, at most 16 images per submission. A slot left empty shows “Slot {x} has no value”.',
            ),
          ],
        },
        {
          id: 'models-params',
          title: '3.4 Models and parameters',
          blocks: [
            p(
              'The row of parameter buttons under the input box decides which model runs and what kind of image comes out:',
            ),
            table(
              ['Parameter', 'What it means'],
              [
                'Model',
                'Open the dropdown to pick a model. Each one is good at different styles and supports different parameters; when in doubt keep the default.',
              ],
              ['[[Ratio]] / [[Size]]', 'Aspect ratio or exact resolution, see the next section.'],
              ['[[Count]]', 'How many images this run produces, 1–10.'],
              [
                '[[Quality]]',
                'Under [[More]]: auto / low / medium / high — higher quality is slower.',
              ],
              ['[[Format]]', 'Under [[More]]: PNG / JPEG / WebP.'],
              [
                '[[Alpha]]',
                'Under [[More]]: available when the format is PNG, and gives you assets on a transparent background.',
              ],
              [
                '[[Compression]]',
                'Under [[More]]: adjustable for JPEG / WebP — the lower the value, the smaller the file.',
              ],
              [
                '[[No rewrite]]',
                'Under [[More]]: on by default, and stops intermediate services from rewriting your prompt.',
              ],
            ),
            shot(
              img('params-more'),
              'The More menu open, showing quality, format, alpha and no-rewrite options',
              '[[More]] only lists the parameters the current model supports',
            ),
            note(
              'Gemini models work a little differently: [[Ratio]], [[Resolution]] and [[Thinking]] take the place of size and quality.',
            ),
          ],
        },
        {
          id: 'size',
          title: '3.5 Setting the size and aspect ratio',
          blocks: [
            p(
              'Click [[Ratio]] (or [[Size]]) to open the dialog. Which name the button shows depends on the model:',
            ),
            list(
              '**[[Smart ratio (Auto)]]** (called [[Auto]] in size mode): the model decides the size, which is what you want when you are unsure.',
              '**[[By ratio]]**: pick a common ratio such as 1:1, 3:4 or 16:9, or click [[Custom ratio]] and type a value like 5:4. Models that support exact resolutions also let you pick a [[Base resolution]] of 1K / 2K / 4K.',
              '**[[Custom size]]**: only shows up on models that accept exact sizes, and takes width and height in pixels.',
            ),
            shot(
              img('size-picker'),
              'The aspect ratio dialog, with the common ratios listed under the by-ratio tab',
              'Pick a ratio and click [[Confirm]]',
            ),
            table(
              ['Use case', 'Recommended ratio'],
              ['Product hero images, avatars, social posts', '1:1'],
              ['Feed covers, posters, phone wallpapers', '3:4, 2:3, 9:16'],
              ['Article headers, website banners, video thumbnails', '16:9, 21:9'],
            ),
            note(
              'Width and height have to be multiples of 16, the longest side at most 3840, and the aspect ratio within 3:1. Sizes that do not fit are adjusted for you, with the message “Model limits normalized the original resolution”.',
            ),
          ],
        },
        {
          id: 'mask-edit',
          title: '3.6 Inpainting (mask editing)',
          blocks: [
            p(
              'Only one small part needs to change — a different color, one stray object gone? Mask editing repaints just the area you paint and leaves everything else untouched.',
            ),
            steps(
              'Click [[Edit output]] on a work card, or the brush icon on a reference thumbnail, or right-click any image and choose [[Edit]].',
              'In the “Edit mask” window, use [[Lasso]] to loop the area (it closes when you release) or [[Paint]] to brush it directly; [[Erase]] takes paint back off. Everything covered in blue is what gets repainted.',
              'Click [[Save]]. The image moves to the front of the reference row with a MASK badge, and the generate button becomes [[Edit mask]].',
              'Spell out in the prompt what that area should become, for example “replace the cup with a pink ceramic mug”, then click [[Edit mask]].',
            ),
            warn(
              'Only one mask image is allowed at a time. Submitting without painting anything shows “Select or paint the area you want to edit first”.',
            ),
          ],
        },
        {
          id: 'saved-prompts',
          title: '3.7 Templates and saved prompts',
          blocks: [
            p(
              'You do not have to retype the wording you use every day — Muvloom has two ways to reuse it:',
            ),
            list(
              '**Saved prompts**: with the prompt written, click the bookmark button [[Save as template]] in the input box and it is stored under [[Assets]] → [[Prompts]] together with the referenced assets and the size, quality and count. Type `/` in the input box to call it back.',
              '**Templates**: the row of round thumbnails under the input box are tuned looks. Click one and the model and size switch for you; attach your product asset with `@` and you get an image in the same look. Click [[More templates]] to see them all.',
            ),
            note(
              'The button says [[Save as template]], but what it saves shows up under [[Assets]] → [[Prompts]]; [[Assets]] → [[Templates]] holds the tuned looks described above. The two are not the same thing.',
            ),
          ],
        },
        {
          id: 'my-works',
          title: '3.8 Managing your works',
          blocks: [
            list(
              '**Filtering**: the star button [[Favorites only]]; the status dropdown offers [[Completed]], [[Generating]] and [[Failed]]; the search box matches prompts and parameters.',
              '**Multi-select**: hold {{Ctrl}} / {{⌘}} and click cards, or press on empty space and drag a selection box; on a phone swipe the cards sideways. A batch bar appears at the bottom for favoriting, downloading or deleting in bulk.',
              '**When a run fails**: open the details to see why. If content review rejected it, click [[Edit the prompt]] and reword it; for anything else click [[Retry task]].',
              '**Closing the page is fine**: jobs on the built-in models keep running on the server and reattach when you refresh or come back.',
            ),
          ],
        },
      ],
    },
    {
      id: 'canvas',
      title: '4. The canvas: edit freely',
      intro: [
        p(
          'The canvas is a whiteboard you can pan forever. Put several images side by side to compare them, circle and annotate right on an image to tell the AI what to change, and every new result lands next to the original so comparing is easy.',
        ),
      ],
      subsections: [
        {
          id: 'canvas-projects',
          title: '4.1 Creating and opening a canvas',
          blocks: [
            list(
              'On the home page switch to [[Canvas]], write a line and click [[Start creating]]: a new canvas project is created and your sentence goes to the AI agent.',
              'Hover the [[Canvases]] row in the sidebar and click [[＋]] [[New canvas]]; click [[All]] to see every canvas project.',
              'Recent canvases are listed below in the sidebar — click a name to open it, or click ↗ for [[Open immersive]], which collapses the sidebar.',
              'Click [[Send to canvas]] on a work card to bring an image you already made onto the current canvas.',
            ),
            p(
              'Canvases save themselves. Once you are signed in, canvas projects sync to the cloud and open on any device.',
            ),
            note(
              'A new project can be an image or a video canvas (on sites with video enabled), and the type cannot be changed afterward.',
            ),
          ],
        },
        {
          id: 'canvas-basics',
          title: '4.2 Canvas basics',
          blocks: [
            shot(
              img('canvas'),
              'Canvas: the chat panel on the left, the toolbar in the middle, an annotated image and the image toolbar',
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
              '**Chat panel**: where you talk to the AI agent; the [[Creations]] tab beside it lists everything made on this canvas.',
              '**Agent input box**: say what you want in one sentence; `@` references images or assets on the canvas.',
              '**Toolbar**: select, hand, pen, eraser, arrow and text, plus undo, redo and zoom.',
              '**Annotations**: circle what should change with the pen, then add an arrow and a text note.',
              '**Image toolbar**: appears once a single image is selected, and offers inpainting, erase, cut out and more.',
            ),
            p(
              'To get images onto the canvas: click [[＋ Import reference images]] in the middle of an empty canvas, drag image files in, or press {{Ctrl}} / {{⌘}} + {{V}}.',
            ),
            p(
              'Moving around: the wheel or a trackpad swipe pans, {{Ctrl}} / {{⌘}} + wheel zooms, and holding {{Space}} lets you drag the view. The minimap in the bottom right jumps anywhere quickly.',
            ),
            table(
              ['Action', 'Shortcut'],
              ['Select / hand', '{{V}} / {{H}}'],
              ['Pen / eraser', '{{D}} / {{E}}'],
              ['Arrow / text', '{{A}} / {{T}}'],
              ['Undo / redo', '{{⌘}}{{Z}} / {{⌘}}{{⇧}}{{Z}} (use {{Ctrl}} on Windows)'],
              ['Copy / paste / duplicate', '{{⌘}}{{C}} / {{⌘}}{{V}} / {{⌘}}{{D}}'],
              ['Select all / add to selection', '{{⌘}}{{A}} / {{Shift}} + click'],
              ['Delete the selection', '{{Delete}} or {{Backspace}}'],
              ['Zoom / temporary hand', '{{⌘}} + wheel / hold {{Space}} and drag'],
              ['Drag without snapping', 'hold {{⌥}} / {{Alt}} while dragging'],
              ['Clear the selection', '{{Esc}}'],
            ),
            tip(
              'Canvas shortcuts do nothing while the cursor sits in a text box. Press {{Esc}} or click empty canvas first. The keyboard icon in the bottom right of the canvas shows the full list.',
            ),
          ],
        },
        {
          id: 'canvas-annotate',
          title: '4.3 Using annotations to point at what changes',
          blocks: [
            steps(
              'Press {{D}} for the pen and circle the spot that should change (there is no ellipse tool — the circle is drawn with the pen).',
              'Press {{A}} to drag an arrow toward it, then press {{T}} and click to write a note such as “add a piece of gold leaf here”.',
              'Press {{V}} to go back to the select tool and click the image. The circles, arrows and text lying on top of it come along automatically.',
              'In the chat panel on the left say “follow the annotations”, or just describe what you want. The new result lands to the right of the original, which stays untouched.',
            ),
            p(
              'The style panel in the top right changes annotation color, stroke width and font size.',
            ),
            warn(
              'The eraser in the toolbar deletes any whole element it touches, images included (press {{⌘}}{{Z}} to undo). To have the AI remove something inside an image, use [[Erase]] on the image toolbar.',
            ),
          ],
        },
        {
          id: 'canvas-image-actions',
          title: '4.4 The image toolbar: inpaint, erase, cut out, expand',
          blocks: [
            p('Select a single image on the canvas and a row of buttons appears underneath it:'),
            table(
              ['Button', 'What it does', 'How to use it'],
              [
                '[[Inpaint]]',
                'Changes only the area you paint',
                'Paint the area with the brush, spell out what it should become and click [[Generate]].',
              ],
              [
                '[[Erase]]',
                'Has the AI remove whatever is inside the painted area and fill the background back in',
                'Paint over what should go and click [[Erase]] — no description needed.',
              ],
              [
                '[[Cut out]]',
                'Removes the background and gives you a transparent PNG',
                'One click.',
              ],
              ['[[Regenerate]]', 'Runs the same settings again', 'One click.'],
              [
                '[[Crop]]',
                'Cuts off what you do not need',
                'Drag the frame handles and click [[Apply]]. Done locally, costs nothing.',
              ],
              [
                '[[Expand]]',
                'Extends the picture outward',
                'Drag the frame outward, optionally say what fills the new area, and click [[Generate]].',
              ],
              [
                '[[More]]',
                'View original, copy, download, delete',
                'Right-clicking the image works too.',
              ],
            ),
            shot(
              img('canvas-inpaint'),
              'Inpainting: painting the area to change on the image, with the description panel at the bottom',
              '[[Inpaint]]: paint the area, then say what it should become',
            ),
            note(
              'Inpaint, erase, cut out and expand **replace the original image**; press {{⌘}}{{Z}} if you do not like the result. Inpaint, erase and expand need a model with mask support (the GPT Image family) — hover a grayed-out button to see why.',
            ),
          ],
        },
        {
          id: 'canvas-export',
          title: '4.5 Multi-select, batch generation and export',
          blocks: [
            list(
              'Drag a selection box or hold {{Shift}} and click several elements, and the batch bar appears at the bottom.',
              '[[Batch generate N]]: one description runs once for every selected image, and each result lands beside its source. Handy for pushing a set of product shots into one style.',
              '[[Export N]]: a single item downloads directly, several are packed into one zip.',
              'A single image can also be right-clicked → [[Download image]], which downloads the original file.',
            ),
          ],
        },
      ],
    },
    {
      id: 'agent',
      title: '5. The AI agent',
      intro: [
        p(
          'The chat panel on the left of the canvas is the AI agent. Say what you need in plain language and it reads the canvas, picks a suitable approach and writes the prompt, and **only starts generating once you confirm**. If prompts are still new to you, this is the place to start.',
        ),
      ],
      subsections: [
        {
          id: 'agent-chat',
          title: '5.1 Talking to the agent',
          blocks: [
            steps(
              'Open a canvas and say what you want in the input box on the left, for example “make a Valentine’s Day poster for this perfume”.',
              'Need reference images? Click the paperclip or drag them in; images selected on the canvas come along automatically, annotations included.',
              'Press {{Enter}} to send. The assistant reads its skills, looks at the canvas and comes back with a draft prompt.',
            ),
            list(
              'Type `@` to reference this turn’s images, images on the canvas, or your assets.',
              'While the assistant is answering you can click [[Stop]]; anything you send meanwhile queues up and runs in order.',
              'The “Generation settings” button under the input box adjusts [[Thinking depth]] (fast / balanced / deep) plus the model and size.',
            ),
            warn(
              'A single turn carries at most 8 reference images. The agent only uses the built-in models, so API keys you configured yourself do not apply here.',
            ),
          ],
        },
        {
          id: 'agent-drafts',
          title: '5.2 Nothing is generated until you confirm',
          blocks: [
            steps(
              'Once the assistant has written the prompt, a draft card appears saying “Read the prompt below — you can edit it — then press Confirm and generate.”',
              'Check the prompt and the model and count at the bottom of the card; anything that looks off can be edited right there.',
              'Click [[Confirm and generate]]. Finished results land on the canvas, and clicking a thumbnail locates them there.',
            ),
            p('When several drafts are waiting at once, [[Confirm all]] submits them in one go.'),
            tip(
              'Tired of confirming every time? Turn on the ⚡ [[Direct generation mode]] next to the input box and the assistant generates as soon as it has a prompt. Note that this spends credits immediately.',
            ),
          ],
        },
        {
          id: 'agent-skills',
          title: '5.3 Skills: professional recipes in one line',
          blocks: [
            p(
              'Skills are how-to guides for the agent. Type `/` at the **start** of the input box to open the skill menu:',
            ),
            table(
              ['Skill', 'Good for'],
              ['Product hero image', 'The image in a listing’s main slot, on white or in a scene'],
              [
                'Product image set',
                'A whole detail-page set in one run: hero, selling points, close-ups and scene shots, each with its own job',
              ],
              [
                'Posters and marketing assets',
                'Posters or campaign key visuals with headline copy',
              ],
              [
                'Scene swap',
                'Keeps the subject pixel for pixel and only puts it in a new background',
              ],
              [
                'Product restyle',
                'Swaps the product, color or material inside one image while background and lighting stay put',
              ],
              [
                'Viral image remix',
                'Recreates a popular image you like, with your own product in it',
              ],
              [
                'Image localization',
                'Replaces the text in an image with another language, layout unchanged',
              ],
              [
                'Character sheet',
                'A reusable three-view character sheet so every later image keeps the same look',
              ],
              ['Reverse prompt', 'Reads a reference image and writes a prompt that reproduces it'],
              [
                'Create asset / create template',
                'Turns the images you have into an asset, or saves a look you like as a template',
              ],
            ),
            p(
              'Video projects come with their own set: make an image move, storyboard shorts, product hero videos, review-style videos and brand films.',
            ),
          ],
        },
        {
          id: 'agent-tips',
          title: '5.4 Helping the agent understand you',
          blocks: [
            list(
              '**Lead with the goal and where it will be used**: “for a marketplace listing thumbnail” or “for an Instagram post” is worth far more than “make a nice picture”.',
              '**Change one thing at a time**: settle the overall style first, then work through the details.',
              '**Lean on reference images and annotations**: circling and pointing is more precise than describing.',
              '**Answer the assistant’s questions carefully**: it offers a few directions to choose from, and [[Other…]] lets you write your own.',
            ),
          ],
        },
      ],
    },
    {
      id: 'video',
      title: '6. Video',
      intro: [
        note(
          'Video has to be enabled for the site and needs at least one working video model; without it none of these entry points show up.',
        ),
      ],
      subsections: [
        {
          id: 'video-start',
          title: '6.1 Making an image move',
          blocks: [
            list(
              'Right-click any image, or use the top-right menu in the fullscreen viewer, and choose [[Make video]]. A video canvas is created with that image as the first frame.',
              'You can also pick the video type when creating a project, then select an image on the video canvas and describe the motion and camera move.',
              'One selected image becomes the first frame; with two, the left one is the first frame and the right one the last. When the model supports reference images, several images can act as references — refer to them as “Image 1, Image 2” in the description.',
            ),
          ],
        },
        {
          id: 'video-params',
          title: '6.2 Video parameters',
          blocks: [
            p(
              'Video has three parameters — [[Duration]], [[Aspect ratio]] and [[Resolution]] — defaulting to 5 seconds, 16:9 and 720p. Models differ in what they support:',
            ),
            table(
              ['Model', 'Duration (s)', 'Aspect ratio', 'Resolution'],
              ['Grok', '5 / 8 / 10 / 15', '16:9, 9:16, 1:1', '720p / 1080p'],
              ['Seedance 2.0', '5 / 8 / 10 / 15', '16:9, 9:16, 1:1', '720p / 1080p'],
              ['Agnes 2.5 Flash', '5 / 8 / 10', '16:9, 9:16, 1:1', '720p'],
              ['Veo 3.1 Fast / Lite', '4 / 6 / 8', '16:9, 9:16', '720p / 1080p'],
            ),
            note(
              'With a first frame the aspect ratio follows that frame. The interface is the source of truth — a site can add or drop models at any time.',
            ),
          ],
        },
        {
          id: 'video-timeline',
          title: '6.3 Extending, editing and exporting a film',
          blocks: [
            list(
              'Select a clip and its toolbar offers [[Download]], [[Regenerate]], [[First frame]], [[Last frame]] and [[Add to timeline]].',
              '**Extend**: adds 2–10 seconds after the last frame; **Edit**: keeps the shot and changes the content.',
              'Once several clips are on the timeline with [[Add to timeline]], trim their in and out points and then [[Export film]] (up to 8 clips and 3 minutes; keep the page in the foreground while it exports).',
            ),
          ],
        },
      ],
    },
    {
      id: 'explore',
      title: '7. Exploring inspiration',
      subsections: [
        {
          id: 'explore-browse',
          title: '7.1 Browsing and searching',
          blocks: [
            p(
              'Click [[Explore]] in the sidebar for the best examples other people made, each one with its full prompt.',
            ),
            shot(
              img('explore'),
              'Explore page: model tabs and the search box at the top, categories on the left, inspiration cards in the middle',
              'The Explore page',
            ),
            list(
              'Filter by model at the top: [[All]], GPT Image, Nano Banana 2.',
              'Pick a category on the left, or search by title, prompt or tag in the search box.',
              'Hover a card to read its prompt; the star button [[Pin]] keeps the ones you like at the front.',
            ),
          ],
        },
        {
          id: 'explore-apply',
          title: '7.2 Borrowing an idea in one click',
          blocks: [
            steps(
              'Click any card to open the details, where you can view the original image and [[Copy]] the full prompt.',
              'Click [[Use this prompt]]: the prompt, its parameters and its reference images go into the home input box, and the recommended model is selected wherever possible.',
              'Swap the subject in the prompt for your own and click [[Generate]].',
            ),
            shot(
              img('explore-detail'),
              'Inspiration details: the large image, the full prompt and the Use this prompt button',
              'Inspiration details',
            ),
            note(
              'When the input box already holds something you are asked whether to [[Replace and apply]]. The inspiration chips under the home input box do exactly the same thing.',
            ),
          ],
        },
      ],
    },
    {
      id: 'assets',
      title: '8. Assets: subjects, prompts and templates',
      intro: [
        p(
          'Click [[Assets]] in the sidebar for the things you saved yourself, split across four tabs: [[Projects]], [[Assets]], [[Prompts]] and [[Templates]].',
        ),
      ],
      subsections: [
        {
          id: 'assets-projects',
          title: '8.1 Projects',
          blocks: [
            p(
              'Every canvas project lives here and can be searched, renamed and deleted. Once you are signed in with sync on, deleted projects go to the bin first and can be restored during the retention window.',
            ),
          ],
        },
        {
          id: 'assets-materials',
          title: '8.2 Assets: the products and people you use often',
          blocks: [
            p(
              'An asset is “a group of images of one subject”: the front, side and close-up of a product, or several photos of the same person. Once saved, it goes into your reference images in one click.',
            ),
            steps(
              'Click [[New asset]] and drag one or more images of the same subject into the “Images” area.',
              'Fill in the name (20 characters at most), set the kind to “Product” or “Person”, and click [[Save]].',
            ),
            list(
              'A faster route: right-click a reference thumbnail in the input box → [[Save as asset]]; or drag images straight onto the [[Assets]] tab.',
              'To use one: [[Add reference]] on the asset card puts it in the reference row; or type `@` in the input box and pick the asset.',
            ),
          ],
        },
        {
          id: 'assets-prompts',
          title: '8.3 Prompts',
          blocks: [
            p(
              'Every prompt saved with [[Save as template]] on the Create page is here, together with the assets and parameters it references. [[Apply]] puts it back in the input box, and typing `/` in the input box searches them directly.',
            ),
          ],
        },
        {
          id: 'assets-looks',
          title: '8.4 Templates: the same look in one click',
          blocks: [
            p(
              'A template is a tuned “look”: a particular light, scene and layout. Drop your product assets into one and you get a batch of images in the same style.',
            ),
            shot(
              img('assets-looks'),
              'The Templates tab on the Assets page, showing the built-in template cards',
              '[[Assets]] → [[Templates]]',
            ),
            list(
              '**Built-in templates** can be used as they are; click [[Copy and edit]] to change one.',
              '**New template**: drop in a poster or shot you want to reproduce, give it a name and pick a purpose (hero / poster / scene / detail). The agent can build one for you too.',
              '**Generating with it**: choose the assets to feed in (they have to be of the “Product” or “Person” kind), set how many images per entry, and submit the batch.',
            ),
            note(
              '[[Generate with it]] and [[Keep tuning]] need you signed in on a site with cloud sync. When the model a template is bound to goes away, it shows [[Needs retuning]].',
            ),
          ],
        },
      ],
    },
    {
      id: 'account',
      title: '9. Account, data and settings',
      subsections: [
        {
          id: 'account-login',
          title: '9.1 Signing in and signing up',
          blocks: [
            shot(
              img('login'),
              'The sign-in dialog: third-party providers plus email and password',
              'The sign-in dialog',
            ),
            list(
              'Click [[Sign in]] in the top right and use a third-party account or an email and password.',
              'No account yet? Click [[Sign up]]: enter your email and a password of at least 8 characters, then the 6-digit code sent to your inbox.',
              'Once signed in, the avatar menu → [[Account settings]] lets you set or change the password and link third-party accounts.',
            ),
            tip(
              'Not sure where you signed in before? Work made in this browser beforehand is recovered automatically the first time you sign in, so nothing is lost.',
            ),
          ],
        },
        {
          id: 'account-data',
          title: '9.2 Where your data lives',
          blocks: [
            table(
              ['What', 'Where it is kept'],
              [
                'Works, assets, prompts, templates, canvas projects, preferences',
                'Synced to the cloud once you sign in and visible on every device; kept in this browser only while signed out',
              ],
              ['API keys you configured yourself', 'This browser only, never uploaded'],
              ['Interface language, theme', 'This browser only'],
            ),
            p(
              'A small yellow dot on your avatar means changes are still waiting to be saved. [[Settings]] → [[Data]] shows the save status, and [[Retry now]] pushes again after a failure; saving also resumes on its own once the network is back, so local data is never lost.',
            ),
            p(
              '[[Settings]] → [[Data]] also exports and imports a ZIP backup, or clears the data in this browser (clearing cannot be undone, so export first).',
            ),
          ],
        },
        {
          id: 'account-credits',
          title: '9.3 Credits and quotas',
          blocks: [
            p(
              'On sites with credits enabled, the balance available to you is shown in the top right:',
            ),
            list(
              'Every run deducts credits up front based on the model and the number of images (videos by the second); failed or canceled jobs give them back.',
              'When credits run out the generate button is disabled, hovering it shows how many you are short, and [[Top up credits]] sits right beside it.',
              'Clicking the balance or the avatar menu opens [[Account overview]], [[Credit history]], plans and referral rewards.',
            ),
            note(
              'Some sites cap the number of generations with a daily quota instead, which resets at 00:00 UTC.',
            ),
          ],
        },
        {
          id: 'account-settings',
          title: '9.4 Settings worth knowing',
          blocks: [
            list(
              '**Language and theme**: [[Language]] (中文 / English) and [[Theme]] (light / dark / system) in the avatar menu.',
              '**Habits**: [[Settings]] → [[General]] changes the submit shortcut, [[Clear the input after submitting]], [[Restore the last input on restart]] and more.',
            ),
          ],
        },
        {
          id: 'account-byok',
          title: '9.5 Using your own API key',
          blocks: [
            p(
              'When a site allows your own keys, [[Settings]] has an [[API]] tab where you can plug in your own model service:',
            ),
            steps(
              'Open [[Settings]] → [[API]] and pick [[New profile]] in the “Current profile” dropdown.',
              'Set [[Provider type]] to “OpenAI-compatible API” or “Gemini”, then fill in [[API URL]] and [[API Key]].',
              '[[Model ID]] can be filled in by clicking [[Fetch models]], or typed by hand. Closing the dialog saves automatically.',
            ),
            warn(
              'With your own key the browser talks to your provider directly, so closing the page interrupts jobs in flight; the agent never uses these profiles either.',
            ),
          ],
        },
      ],
    },
    {
      id: 'tips',
      title: '10. Going further',
      subsections: [
        {
          id: 'tips-workflow',
          title: '10.1 From idea to delivery',
          blocks: [
            steps(
              '**Think it through**: where it will be used, who sees it, which style, and what text has to appear.',
              '**Draft**: write a detailed prompt, generate 2–4 images in one run and keep the one closest to your direction.',
              '**Refine**: work the details with inpainting, canvas annotations or the agent, one change at a time.',
              '**Scale it up**: batch generate with slots and templates, or ask the agent for a whole set with the product image set skill.',
              '**Deliver**: set the ratio you need, then download the originals or export in bulk.',
            ),
          ],
        },
        {
          id: 'tips-reference',
          title: '10.2 Getting the most from reference images',
          blocks: [
            list(
              '**Real product photos**: keep the generated product true to the real thing, and save them as an asset to reuse.',
              '**Style references**: let the AI pick up the palette and texture, and say so in the prompt — “follow the color tone of @Image 2”.',
              '**Composition references**: pin down the layout, which is how a poster series stays consistent.',
              'The sharper the reference and the clearer its subject, the better the result.',
            ),
          ],
        },
        {
          id: 'tips-ecommerce',
          title: '10.3 Tips for e-commerce images',
          blocks: [
            list(
              'Let the hero image show the product itself; decoration should never outshine it.',
              'Boil the selling points down to 3–5 keywords and put them in the text part of the prompt.',
              'Use the ratio the platform asks for (1:1 for hero images, 3:4 for detail pages) and leave a safe margin.',
              'Generate a few versions of the same brief and keep whichever performs better.',
            ),
          ],
        },
      ],
    },
  ],
  faq: {
    id: 'faq',
    title: 'Common questions',
    items: [
      {
        q: 'The sign-in dialog opened when I clicked Generate and nothing was generated?',
        a: 'The built-in models require an account. After signing in the page reloads with your text and earlier works intact, so click Generate once more.',
      },
      {
        q: 'The reference image button is grayed out and I cannot add an image?',
        a: 'The current model has no support for reference images (image-to-image). Pick a model in the dropdown that does. Reference images are also capped at 16, each under 10MB.',
      },
      {
        q: 'I cannot find the transparent background or compression option under More?',
        a: 'These options follow the model and the format: alpha only appears when the format is PNG, compression only for JPEG or WebP, and Gemini models expose a different set of parameters.',
      },
      {
        q: 'What do I do about the “at most 16 images per submission” message?',
        a: 'Your slot combinations multiplied by the count went past 16. Remove some slot values or lower the count, and run it in a few passes.',
      },
      {
        q: 'The inpaint, erase and expand buttons are grayed out?',
        a: 'These need a model with mask support (the GPT Image family), and the image cannot be too small or too elongated. Hover the button to see the exact reason.',
      },
      {
        q: 'Why did nothing generate after I messaged the agent?',
        a: 'The agent drafts the prompt first and waits for you to press Confirm and generate. To skip the confirmation, turn on direct generation mode next to the input box, but it spends credits right away.',
      },
      {
        q: 'The canvas eraser wiped out my whole image?',
        a: 'The toolbar eraser deletes any element it touches; press Ctrl/⌘ + Z to undo. To have the AI remove an object inside an image, select the image and use Erase on its toolbar.',
      },
      {
        q: 'Where did Save as template put my prompt?',
        a: 'It is saved on the Assets page, in the Prompts tab, and typing / in the input box brings it back. The Templates tab holds the tuned looks, which are a different thing.',
      },
      {
        q: 'Generation failed with a content review error?',
        a: 'Retrying the same prompt fails the same way. Open the work details, click Edit the prompt and word it differently.',
      },
      {
        q: 'If I close the tab, are jobs in progress lost?',
        a: 'Jobs on the built-in models keep running on the server and reattach when you open the page again. Jobs using your own API key are requested by the browser directly, so closing the page interrupts them.',
      },
      {
        q: 'I switched computers, are my works still there?',
        a: 'Sign in with the same account to see the works, assets, prompts, templates and canvas projects saved in the cloud. Data made while signed out stays in the original browser and is merged into your account when you sign in.',
      },
    ],
  },
}
