import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./features/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Space Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        void: "#080807",
        panel: "#0d0d0b",
        signal: "#ff5a0a",
        phosphor: "#9bbd86",
        terminal: "#d7d3cc",
        dim: "#77736c",
      },
      boxShadow: {
        glow: "0 0 18px rgb(255 90 10 / 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
