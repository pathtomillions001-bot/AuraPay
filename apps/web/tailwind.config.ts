import type { Config } from 'tailwindcss';

/**
 * AuraPay's own visual language — "obsidian ledger".
 *
 * Deliberately not a glassmorphism remix of someone else's fintech: the accent is
 * a two-tone halo (mint for verified states, amber for anything still in motion),
 * numerals are tabular mono because money must line up to be read, and the only
 * decoration allowed on a money screen is a hairline.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        abyss: '#05070a',
        obsidian: '#0a0e14',
        slate: { 950: '#0d1219', 900: '#111823', 800: '#18212e', 700: '#212c3c' },
        hair: '#1d2735',
        mint: { DEFAULT: '#57e3b4', dim: '#2f9d7c' },
        amber: { DEFAULT: '#f0b25c', dim: '#a97b36' },
        rose: { DEFAULT: '#f0788f', dim: '#a8505f' },
        ink: { DEFAULT: '#e8eef6', dim: '#96a3b6', faint: '#5d6b7f' },
      },
      fontFamily: {
        display: ['ui-serif', 'Iowan Old Style', 'Charter', 'Georgia', 'serif'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        lift: '0 1px 0 rgba(255,255,255,0.04) inset, 0 20px 60px -30px rgba(0,0,0,0.9)',
        halo: '0 0 0 1px rgba(87,227,180,0.18), 0 18px 60px -28px rgba(87,227,180,0.35)',
      },
      keyframes: {
        drift: { '0%,100%': { transform: 'translate3d(0,0,0)' }, '50%': { transform: 'translate3d(0,-8px,0)' } },
        sheen: { '0%': { backgroundPosition: '-140% 0' }, '100%': { backgroundPosition: '240% 0' } },
        pulseDot: { '0%,100%': { opacity: '0.35' }, '50%': { opacity: '1' } },
      },
      animation: {
        drift: 'drift 9s ease-in-out infinite',
        sheen: 'sheen 2.4s linear infinite',
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
export default config;
