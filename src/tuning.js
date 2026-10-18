// The adjustable look of the night: moonlight, sky light, fog and the air, the temples' marble, the final grade.
// tuning.json in the project holds the values.

export const TUNING_DEFAULTS = {
  moon: { elevation: 19.5, azimuth: 163.3, intensity: 2.6, color: '#eaf1ff' },
  sky: { color: '#6f8ece', ground: '#303f5d', intensity: 1.6 },
  fog: { density: 0.0032, color: '#394e76' },
  air: {
    density: 0.0014, color: '#3e5687', glowColor: '#7f97cc', glow: 0.71,
    mist: 0.011, mistHeight: 1.4, mistColor: '#6880b0',
  },
  temples: {
    color: '#e9e6de', roughness: 0.72, litTint: '#ffffff', shadeTint: '#ffffff',
    ao: 1, grime: 1, veins: 1, relief: 1, wet: 1,
  },
  post: { exposure: 1, bloom: 0.42, bloomRadius: 0.55, bloomThreshold: 1, vignette: 0.45, grade: 0.5 },
};

// file / defaults: another page (the two-tone one) keeps its own settings the same way.
export async function loadTuning({ file = 'tuning.json', defaults = TUNING_DEFAULTS } = {}) {
  const t = structuredClone(defaults);
  try {
    const r = await fetch(file, { cache: 'no-store' });
    if (r.ok) {
      const src = await r.json();
      for (const group of Object.keys(t)) if (src?.[group]) Object.assign(t[group], src[group]);
    }
  } catch { /* no file: the defaults */ }
  return t;
}
