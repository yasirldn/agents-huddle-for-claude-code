import { html } from "./lib.js";

// Each agent is a small figure. Its colour shows where it sits in the list, from
// orange at the top through green to blue at the bottom. Its outline stays the
// same, so an agent can still be told apart when the order changes. Its face and
// movement show what it is doing.

const STOPS = [
  { l: 0.672, c: 0.131, h: 38.8 }, // orange
  { l: 0.78, c: 0.135, h: 78 }, // gold
  { l: 0.75, c: 0.14, h: 148 }, // green
  { l: 0.73, c: 0.11, h: 192 }, // teal
  { l: 0.665, c: 0.13, h: 258 }, // blue
];

function oklchToRgb(l, c, h) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3);
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
}

// Colours past the edge of the screen's range lose a little saturation instead of being clipped.
function color(l, c, h) {
  let chroma = c;
  let rgb = oklchToRgb(l, chroma, h);
  while (chroma > 0 && rgb.some((v) => v < 0 || v > 1)) {
    chroma -= 0.004;
    rgb = oklchToRgb(l, chroma, h);
  }
  const encode = (v) => Math.round(Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255);
  return `rgb(${rgb.map(encode).join(",")})`;
}

const tints = new Map();
export function tint(tone = 0) {
  const t = Math.min(1, Math.max(0, Math.round(tone * 100) / 100));
  if (!tints.has(t)) {
    const span = STOPS.length - 1;
    const index = Math.min(span - 1, Math.floor(t * span));
    const [from, to, u] = [STOPS[index], STOPS[index + 1], t * span - index];
    const l = from.l + (to.l - from.l) * u;
    const c = from.c + (to.c - from.c) * u;
    const h = from.h + (to.h - from.h) * u;
    tints.set(t, { body: color(l, c, h), shade: color(l - 0.09, c * 0.95, h) });
  }
  return tints.get(t);
}

const INK = "#17171a";
const CHEEK = "#ff9db0";
const PALM = "#fff4ea";

const OUTLINES = [
  { face: 0, sheen: [10, 11.5], body: (fill) => html`<rect x="6" y="8" width="28" height="30" rx="7" fill=${fill} />` },
  { face: 1.5, sheen: [12, 15], body: (fill) => html`<path d="M6 24a14 14 0 0 1 28 0v9a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z" fill=${fill} />` },
  {
    face: 2,
    sheen: [10, 15.5],
    body: (fill, shade) => html`
      <rect x="19" y="5" width="2" height="8" rx="1" fill=${shade} />
      <circle cx="20" cy="4.5" r="2.5" fill=${fill} />
      <rect x="5" y="12" width="30" height="26" rx="9" fill=${fill} />
    `,
  },
  {
    face: 1,
    sheen: [11, 14],
    body: (fill) => html`
      <circle cx="11.5" cy="11.5" r="4.5" fill=${fill} />
      <circle cx="28.5" cy="11.5" r="4.5" fill=${fill} />
      <rect x="6" y="10" width="28" height="28" rx="8" fill=${fill} />
    `,
  },
];

// How each state moves: dancing while working, swaying while reading or
// thinking, jumping while it needs you, one hop when it finishes, still at rest.
const MOTION = { type: "dance", look: "sway", think: "sway", ask: "jump", done: "cheer", idle: "rest" };

function eyes(mood) {
  if (mood === "done") {
    return html`
      <path d="M12.6 23.6q2.4-3.2 4.8 0" fill="none" stroke=${INK} stroke-width="1.7" stroke-linecap="round" />
      <path d="M22.6 23.6q2.4-3.2 4.8 0" fill="none" stroke=${INK} stroke-width="1.7" stroke-linecap="round" />
    `;
  }
  const big = mood === "ask";
  const rx = big ? 2.3 : 2;
  const ry = big ? 2.9 : 2.6;
  return html`
    <ellipse cx="15" cy="22.5" rx=${rx} ry=${ry} fill=${INK} />
    <ellipse cx="25" cy="22.5" rx=${rx} ry=${ry} fill=${INK} />
    <circle cx="15.8" cy="21.4" r="0.8" fill="#ffffff" />
    <circle cx="25.8" cy="21.4" r="0.8" fill="#ffffff" />
  `;
}

function mouth(mood) {
  if (mood === "done") {
    return html`
      <path d="M15.8 27.6h8.4a4.2 4.2 0 0 1-8.4 0z" fill=${INK} />
      <ellipse cx="20" cy="30.4" rx="1.9" ry="1" fill=${CHEEK} />
    `;
  }
  if (mood === "ask") return html`<path d="M16.6 27.8h6.8a3.4 3.4 0 0 1-6.8 0z" fill=${INK} />`;
  if (mood === "idle") return html`<path d="M17.4 28.4q2.6 2 5.2 0" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />`;
  return html`<path d="M16.6 28.2q3.4 2.8 6.8 0" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />`;
}

export function Figure({ n = 0, mood = "idle", size = 40, tone = 0 }) {
  const { body, shade } = tint(tone);
  const outline = OUTLINES[n % OUTLINES.length];
  const motion = MOTION[mood] ?? "rest";
  return html`
    <svg class=${`fig fig-${motion} fig-${mood}`} width=${size} height=${size * 1.2} viewBox="0 0 40 48" aria-hidden="true" style=${{ "--fig-delay": `${-(n % 5) * 0.17}s` }}>
      <ellipse class="fig-shadow" cx="20" cy="45.5" rx="11" ry="1.5" fill="rgba(0,0,0,0.4)" />
      <g class="fig-body">
        <rect class="fig-foot fig-foot-left" x="11" y="36" width="6" height="8" rx="2.5" fill=${shade} />
        <rect class="fig-foot fig-foot-right" x="23" y="36" width="6" height="8" rx="2.5" fill=${shade} />
        ${mood === "ask" &&
        html`<g class="fig-arm">
          <rect x="32.5" y="13" width="4" height="14" rx="2" fill=${shade} />
          <circle cx="34.5" cy="11.5" r="3.4" fill=${PALM} />
        </g>`}
        ${outline.body(body, shade)}
        <rect x=${outline.sheen[0]} y=${outline.sheen[1]} width="9" height="2.5" rx="1.25" fill="#ffffff" opacity="0.22" />
        <g transform=${`translate(0 ${outline.face})`}>
          <ellipse cx="11.4" cy="27" rx="2.2" ry="1.3" fill=${CHEEK} opacity="0.55" />
          <ellipse cx="28.6" cy="27" rx="2.2" ry="1.3" fill=${CHEEK} opacity="0.55" />
          <g class="fig-gaze"><g class="fig-eyes">${eyes(mood)}</g></g>
          ${mouth(mood)}
        </g>
      </g>
    </svg>
  `;
}
