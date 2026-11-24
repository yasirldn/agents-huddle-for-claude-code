import { html } from "./lib.js";

// Each agent is a small painted figure. Its colour and outline tell agents apart,
// and its face shows what the agent is doing.
const HUES = [
  { body: "#5b8def", shade: "#4a76cf" },
  { body: "#ee6f9a", shade: "#cf5a83" },
  { body: "#35b8a4", shade: "#2a9c8b" },
  { body: "#9a7df0", shade: "#8167d2" },
  { body: "#f0765a", shade: "#d1614a" },
  { body: "#7cc05e", shade: "#67a44d" },
];
const INK = "#17171a";
const SIGNAL = "#f2b84b";

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

function eyes(mood) {
  if (mood === "done") {
    return html`
      <path d="M12.6 24q2.4-3 4.8 0" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />
      <path d="M22.6 24q2.4-3 4.8 0" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />
    `;
  }
  if (mood === "idle") {
    return html`
      <rect x="12.75" y="22.5" width="4.5" height="1.6" rx="0.8" fill=${INK} />
      <rect x="22.75" y="22.5" width="4.5" height="1.6" rx="0.8" fill=${INK} />
    `;
  }
  if (mood === "ask") {
    return html`
      <circle cx="15" cy="23" r="2.6" fill=${INK} />
      <circle cx="25" cy="23" r="2.6" fill=${INK} />
    `;
  }
  return html`
    <rect x="13.25" y="20.5" width="3.5" height="5" rx="1.75" fill=${INK} />
    <rect x="23.25" y="20.5" width="3.5" height="5" rx="1.75" fill=${INK} />
  `;
}

function mouth(mood) {
  if (mood === "done") return html`<path d="M16.5 29q3.5 3 7 0" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />`;
  if (mood === "ask") return html`<circle cx="20" cy="30.5" r="1.5" fill=${INK} />`;
  return html`<path d="M17.5 30h5" fill="none" stroke=${INK} stroke-width="1.6" stroke-linecap="round" />`;
}

export function Figure({ n = 0, mood = "idle", size = 40 }) {
  const hue = HUES[n % HUES.length];
  const outline = OUTLINES[n % OUTLINES.length];
  return html`
    <svg class=${`fig fig-${mood}`} width=${size} height=${size * 1.2} viewBox="0 0 40 48" aria-hidden="true" style=${{ "--fig-delay": `${-(n % 5) * 1.1}s` }}>
      <ellipse cx="20" cy="45.5" rx="11" ry="1.5" fill="rgba(0,0,0,0.4)" />
      <g class="fig-lift">
        <rect x="11" y="36" width="6" height="8" rx="2.5" fill=${hue.shade} />
        <rect x="23" y="36" width="6" height="8" rx="2.5" fill=${hue.shade} />
        ${mood === "ask" &&
        html`<g class="fig-arm">
          <rect x="32.5" y="13" width="4" height="14" rx="2" fill=${hue.shade} />
          <circle cx="34.5" cy="11.5" r="3.4" fill=${SIGNAL} />
        </g>`}
        ${outline.body(hue.body, hue.shade)}
        <rect x=${outline.sheen[0]} y=${outline.sheen[1]} width="9" height="2.5" rx="1.25" fill="#ffffff" opacity="0.22" />
        <g transform=${`translate(0 ${outline.face})`}>
          <g class="fig-gaze"><g class="fig-eyes">${eyes(mood)}</g></g>
          ${mouth(mood)}
        </g>
      </g>
    </svg>
  `;
}
