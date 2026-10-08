const FONT_STYLESHEETS = [
  'https://fontsapi.zeoseven.com/442/main/result.css',
  'https://cdn.jsdelivr.net/npm/@lobehub/webfont-harmony-sans-sc@1.0.0/css/index.css',
]

/** Fonts must neither block first paint nor share the required application's CSS load result. */
export function optionalFontsPlugin() {
  return {
    name: 'optional-fonts',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        const links = FONT_STYLESHEETS.map(
          (href) =>
            `<link rel="stylesheet" href="${href}" data-optional-style media="print" onload="this.media='all'">`,
        ).join('')
        return html.replace('</head>', `${links}</head>`)
      },
    },
  }
}
