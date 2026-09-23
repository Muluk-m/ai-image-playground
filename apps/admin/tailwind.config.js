import path from 'node:path'

import colors from 'tailwindcss/colors'
import animate from 'tailwindcss-animate'

const privateOverlayEntry = process.env.PRIVATE_ADMIN_OVERLAY_ENTRY

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    privateOverlayEntry,
    privateOverlayEntry ? path.join(path.dirname(privateOverlayEntry), '*.{js,ts,jsx,tsx}') : null,
    privateOverlayEntry
      ? path.join(path.dirname(privateOverlayEntry), 'routes/*.{js,ts,jsx,tsx}')
      : null,
  ].filter(Boolean),
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        gray: colors.zinc,
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger: 'hsl(var(--danger))',
        private: 'hsl(var(--private))',
        brand: {
          DEFAULT: 'hsl(var(--brand-action))',
          hover: 'hsl(var(--brand-action-hover))',
          foreground: 'hsl(var(--brand-action-foreground))',
          ink: 'hsl(var(--brand-ink))',
          'ink-raised': 'hsl(var(--brand-ink-raised))',
          mint: 'hsl(var(--brand-mint))',
        },
        shell: {
          nav: 'hsl(var(--shell-nav-bg))',
          'nav-foreground': 'hsl(var(--shell-nav-fg))',
          'nav-border': 'hsl(var(--shell-nav-border))',
          'nav-label': 'hsl(var(--shell-nav-group-label))',
          'nav-hover': 'hsl(var(--shell-nav-item-hover-bg))',
          'nav-active': 'hsl(var(--shell-nav-item-active-bg))',
          'nav-active-foreground': 'hsl(var(--shell-nav-item-active-fg))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      spacing: {
        'page-x': 'var(--spacing-page-x)',
        'page-y': 'var(--spacing-page-y)',
        section: 'var(--spacing-section)',
        stack: 'var(--spacing-stack)',
        'shell-header': 'var(--shell-header-height)',
        'shell-nav': 'var(--shell-nav-width)',
        'shell-nav-icon': 'var(--shell-nav-width-icon)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
}
