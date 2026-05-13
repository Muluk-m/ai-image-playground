import colors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: colors.zinc,
      },
      fontFamily: {
        sans: ['var(--font-ui-sans)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
  plugins: [],
}
