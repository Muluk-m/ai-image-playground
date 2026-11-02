import web from '../web/tailwind.config.js'
export default {
  ...web,
  content: [...web.content, './src/**/*.{ts,tsx}', '../web/src/**/*.{ts,tsx}'],
}
