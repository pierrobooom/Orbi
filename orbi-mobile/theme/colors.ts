// Cluster palette mirrors the locked HTML sketch (orbi_mobile_sketch.html).
// Internal DB tier values stay 'free'/'pro'/'premium'; marketing names live
// in components that surface them to the user.

export const colors = {
  bg:       "#07080f",  // outermost page background
  canvas:   "#0b0d17",  // bubble universe background
  panel:    "#11142a",  // bottom-sheet / overlay background
  ink:      "#e9ecf5",
  inkDim:   "#8e94b1",
  line:     "#2a2f4a",
  accent:   "#7c6fe0",  // brand accent — mic, primary actions

  // Cluster colors
  work:     "#5b8cff",
  health:   "#4cc38a",
  finance:  "#f5b342",
  personal: "#c476f0",
  home:     "#ff8a65",
  learning: "#4dd0e1",
  drift:    "#6c7393",  // catch-all cluster — neutral gray

  // State overrides
  overdue:  "#ff4d6d",  // overrides cluster color, pulses
} as const;

export type ColorKey = keyof typeof colors;
