// The owner's 20 reference body types (their "Body Base Models" sheet, 16 Nov 2026): ten base
// models and ten shape presets, each as body-editor slider values over the standard female body.
// Matched by eye to the sheet's front, side and back views, then checked as rendered sheets
// (tools/body-type-sheets.mjs). Values not given stay at 0 (the standard body).
export const BODY_TYPES = {
	'Base models': {
		Slim: { note: 'Lean, athletic', v: { height: 168, weight: -0.55, muscle: 0.15, bust: -0.14, waist: -0.35, hips: -0.07, glutes: 0.02, buttLift: 0.3, thighs: -0.21, calves: -0.2, arms: -0.35, thighGap: 0.6, abs: 0.35, breastFirm: 0.4 } },
		Athletic: { note: 'Toned, fit', v: { height: 170, weight: -0.2, muscle: 0.7, shoulders: 0.3, lats: 0.2, waist: -0.35, abs: 0.9, bust: 0.06, glutes: 0.21, buttLift: 0.6, buttOut: 0.1, gluteUpper: 0.14, hips: 0.1, thighs: 0.21, thighOuter: 0.15, calves: 0.35, arms: 0.1, breastFirm: 0.6 } },
		Average: { note: 'Balanced, natural', v: { height: 167, weight: 0.05, bust: 0.14, waist: -0.15, hips: 0.12, glutes: 0.1, buttOut: 0.05, thighs: 0.09, belly: 0.08 } },
		Curvy: { note: 'Soft, feminine', v: { height: 167, weight: 0.3, bust: 0.41, waist: -0.55, hips: 0.5, iliacWidth: 0.2, glutes: 0.35, buttOut: 0.24, buttLift: 0.3, buttFullness: 0.14, thighs: 0.48, thighOuter: 0.25, hipDips: -0.24, belly: 0.08, breastFullness: 0.12 } },
		Voluptuous: { note: 'Full, hourglass', v: { height: 167, weight: 0.6, bust: 0.74, waist: -0.35, hips: 0.68, iliacWidth: 0.3, glutes: 0.45, buttOut: 0.32, buttWidth: 0.3, buttFullness: 0.21, thighs: 0.72, thighOuter: 0.4, thighInner: 0.36, thighGap: -0.7, belly: 0.24, arms: 0.4, calves: 0.4, breastFullness: 0.24, hipDips: -0.3 } },
		Petite: { note: 'Short, compact', v: { height: 152, weight: -0.25, legLength: -0.25, bust: -0.06, waist: -0.35, hips: 0.05, glutes: 0.1, buttLift: 0.4, thighs: -0.03, thighGap: 0.4, breastFirm: 0.4 } },
		Tall: { note: 'Long, lean', v: { height: 186, weight: -0.35, legLength: 0.45, torsoLength: 0.1, neckLength: 0.1, bust: 0.03, waist: -0.4, hips: 0.07, glutes: 0.1, buttLift: 0.4, thighs: -0.06, thighGap: 0.5, abs: 0.2 } },
		'Plus Size': { note: 'Full figure', v: { height: 167, weight: 0.85, muscle: -0.1, bust: 0.55, waist: 0.15, belly: 0.44, midWidth: 0.28, fupa: 0.42, hips: 0.6, glutes: 0.39, buttOut: 0.21, buttWidth: 0.4, thighs: 0.78, thighInner: 0.48, thighGap: -1, arms: 0.8, calves: 0.7, breastFirm: -0.3, hipDips: -0.36 } },
		BBW: { note: 'Curvy, plus', v: { height: 167, weight: 1, muscle: -0.15, bust: 0.72, waist: 0, belly: 0.4, midWidth: 0.32, fupa: 0.56, hips: 0.75, iliacWidth: 0.4, glutes: 0.52, buttOut: 0.39, buttWidth: 0.5, buttFullness: 0.21, thighs: 0.9, thighOuter: 0.5, thighInner: 0.6, thighGap: -1, arms: 1, calves: 0.9, breastFirm: -0.4, hipDips: -0.48 } },
		Thick: { note: 'Muscular, curvy', v: { height: 168, weight: 0.35, muscle: 0.55, shoulders: 0.2, bust: 0.39, waist: -0.4, abs: 0.3, hips: 0.6, iliacWidth: 0.3, glutes: 0.49, gluteUpper: 0.21, gluteShelf: 0.14, buttOut: 0.35, buttLift: 0.5, buttWidth: 0.3, thighs: 0.78, thighOuter: 0.45, hamstring: 0.35, thighGap: -0.6, calves: 0.7, arms: 0.4, hipDips: -0.42 } }
	},
	'Body shapes': {
		Hourglass: { note: 'Bust and hips even, narrow waist', v: { weight: 0.15, bust: 0.55, waist: -0.9, hips: 0.5, glutes: 0.32, buttOut: 0.17, thighs: 0.3, breastFirm: 0.3, hipDips: -0.24 } },
		Pear: { note: 'Narrow top, full hips and thighs', v: { weight: 0.15, shoulders: -0.4, chest: -0.2, bust: -0.17, waist: -0.3, hips: 0.6, iliacWidth: 0.25, glutes: 0.35, buttWidth: 0.3, thighs: 0.66, thighOuter: 0.4, thighGap: -0.4 } },
		Apple: { note: 'Full middle, slimmer legs', v: { weight: 0.45, bust: 0.55, chest: 0.3, waist: 0.9, belly: 0.72, midWidth: 0.64, fupa: 0.35, hips: 0.1, glutes: 0.07, thighs: 0.06, arms: 0.4, thighGap: 0.1 } },
		'Inverted Triangle': { note: 'Broad shoulders, narrow hips', v: { weight: -0.1, shoulders: 0.9, chest: 0.5, lats: 0.4, bust: 0.33, waist: -0.1, hips: -0.25, glutes: -0.03, thighs: -0.12, thighGap: 0.4 } },
		Rectangle: { note: 'Straight, little waist', v: { weight: 0, shoulders: 0.15, bust: 0, waist: 0.6, midWidth: 0.24, hips: -0.07, glutes: 0, buttOut: -0.07, thighs: 0 } },
		Triangle: { note: 'Hips wider than shoulders', v: { weight: 0.2, shoulders: -0.25, bust: 0.06, waist: 0, belly: 0.16, hips: 0.45, glutes: 0.21, buttWidth: 0.25, thighs: 0.48, thighInner: 0.3, thighGap: -0.4, calves: 0.3 } },
		Athletic: { note: 'Toned, defined', v: { muscle: 0.6, weight: -0.15, shoulders: 0.25, waist: -0.3, abs: 0.8, bust: 0.17, glutes: 0.17, buttLift: 0.5, hips: 0.1, thighs: 0.18, calves: 0.3, breastFirm: 0.5 } },
		Curvy: { note: 'Soft curves all round', v: { weight: 0.35, bust: 0.5, waist: -0.4, hips: 0.45, glutes: 0.32, buttOut: 0.21, thighs: 0.42, belly: 0.12, breastFullness: 0.12 } },
		Thicc: { note: 'Big hips, butt and thighs, small waist', v: { weight: 0.4, bust: 0.5, waist: -0.6, hips: 0.7, iliacWidth: 0.35, glutes: 0.52, buttOut: 0.42, buttWidth: 0.4, buttFullness: 0.17, gluteUpper: 0.17, thighs: 0.78, thighOuter: 0.45, thighGap: -0.8, hipDips: -0.48 } },
		BBL: { note: 'Very large high, round butt; very small waist', v: { weight: 0.1, bust: 0.5, waist: -1.1, belly: -0.24, hips: 0.75, iliacWidth: 0.5, glutes: 0.52, gluteUpper: 0.45, gluteShelf: 0.42, buttOut: 0.45, buttLift: 0.9, buttWidth: 0.5, buttFullness: 0.28, pelvicTilt: 0.6, thighs: 0.48, thighOuter: 0.4, hipDips: -0.6, breastFirm: 0.6 } }
	}
};

/** Slider values for a type, over the standard female body (pass the editor's defaults). */
export function bodyType(group, name, base) {
	const t = BODY_TYPES[group]?.[name];
	return t ? { ...base, ...t.v } : null;
}
