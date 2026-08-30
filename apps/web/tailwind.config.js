import { dirname } from 'node:path';

import colors from 'tailwindcss/colors';

const privateWebOverlayEntry = process.env.PRIVATE_WEB_OVERLAY_ENTRY;
const privateWebOverlayRoot = privateWebOverlayEntry
  ? dirname(privateWebOverlayEntry)
  : undefined;
const privateWebOverlayContent = privateWebOverlayRoot
  ? [
      `${privateWebOverlayRoot}/**/*.{js,ts,jsx,tsx}`,
      `!${privateWebOverlayRoot}/**/{node_modules,dist}/**`,
    ]
  : [];

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    ...privateWebOverlayContent,
  ],
  theme: {
    extend: {
      colors: {
        gray: colors.zinc,
      },
      fontFamily: {
        sans: ['var(--font-ui-sans)'],
        display: ['var(--font-display)', 'var(--font-ui-sans)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
}
