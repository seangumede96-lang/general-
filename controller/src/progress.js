// Progress for a machine that is starting up: which step it is on, how far along, how long it
// has taken, and an estimate of how long is left. Estimates come from measured times of earlier
// runs and are corrected as the machine reports progress; they are never presented as exact.

/** Steps per kind of machine, with typical seconds for each. Step 0 is booting, before the machine reports anything. */
export const PLANS = {
	brain: [
		{ label: 'Starting the machine and downloading the model', est: 300 },
		{ label: 'Loading the model into memory', est: 75 }
	],
	image: [
		{ label: 'Starting the machine', est: 150 },
		{ label: 'Installing the image engine', est: 120 },
		{ label: 'Downloading models', est: 300, totalGb: 37 },
		{ label: 'Starting the image engine', est: 45 }
	],
	video: [
		{ label: 'Starting the machine', est: 150 },
		{ label: 'Installing the video engine', est: 150 },
		{ label: 'Installing add-ons', est: 150 },
		{ label: 'Downloading models', est: 600, totalGb: 40 },
		{ label: 'Starting the video engine', est: 60 }
	]
};

/**
 * The brain's steps for one particular model: its own name and download size, and a time that
 * grows with the size. `model` is { label, sizeGb }.
 */
export function brainPlan(model) {
	const gb = model?.sizeGb;
	return [
		{ label: `Starting the machine and downloading ${model?.label || 'the model'}${gb ? ` (${gb} GB)` : ''}`, est: Math.round(120 + (gb || 20) * 9) },
		{ label: `Loading ${model?.label || 'the model'} into memory`, est: Math.round(30 + (gb || 20) * 2) }
	];
}

/** The image plan with the download size of this session's actual files (models plus chosen LoRAs). */
export function imagePlan(totalGb) {
	return PLANS.image.map((s) => (s.totalGb && totalGb ? { ...s, totalGb, est: Math.round(60 + totalGb * 6) } : s));
}

/** Index of a setup-log step such as "2/3 Downloading models (1 of 5 files, 9 GB)", plus its detail. */
export function parseStep(text) {
	const m = /^(\d+)\/(\d+)\s*(.*)$/.exec(String(text || '').trim());
	return m ? { index: Number(m[1]), detail: m[3] } : null;
}

/**
 * Keeps, per machine, the step it is on and when anything last changed. `report(id, text)` is
 * called with the latest log line whenever it is read; the times are what make the timer and
 * the "no news for a while" warning honest.
 */
export function createTracker(clock = Date.now) {
	const seen = new Map();
	return {
		report(id, index, text) {
			const now = clock();
			const prev = seen.get(id);
			if (!prev || prev.index !== index) seen.set(id, { index, text, stepSince: now, changedAt: now });
			else if (prev.text !== text) Object.assign(prev, { text, changedAt: now });
		},
		/** Per-file download progress from the machine's files.txt, with a speed from the previous reading. */
		files(id, text) {
			const now = clock();
			const entry = seen.get(id);
			if (!entry) return;
			const before = new Map((entry.files || []).map((f) => [f.name, f]));
			entry.files = String(text).trim().split('\n').map((line) => {
				const [name, done, total] = line.trim().split(/\s+/);
				const f = { name, done: Number(done) || 0, total: Number(total) || 0, at: now, speed: 0 };
				const prev = before.get(name);
				f.speed = prev && now > prev.at && f.done >= prev.done ? ((f.done - prev.done) / ((now - prev.at) / 1000)) : prev?.speed || 0;
				if (prev && f.done === prev.done) f.speed = prev.done === f.total ? 0 : prev.speed * 0.5;
				return f;
			}).filter((f) => f.name);
			if (entry.files.some((f) => f.done !== before.get(f.name)?.done)) entry.changedAt = now;
		},
		get: (id) => seen.get(id) || null,
		forget: (id) => seen.delete(id)
	};
}

/**
 * The numbers the page shows. `state` is the tracker entry (or null while booting). All times in
 * milliseconds except the returned seconds.
 */
export function computeProgress(kind, startedAt, state, now = Date.now(), plan = PLANS[kind]) {
	const index = Math.min(state?.index ?? 0, plan.length - 1);
	const stepSince = state?.stepSince ?? startedAt;
	const changedAt = state?.changedAt ?? startedAt;
	const step = plan[index];
	const inStep = Math.max(0, (now - stepSince) / 1000);

	// During a download the machine reports gigabytes done, which gives a measured speed.
	let fraction = null;
	const gb = /(\d+) of (\d+) files, (\d+) GB/.exec(state?.text || '');
	const files = /download/i.test(step.label) ? (state?.files || []) : [];
	const total = files.reduce((n, f) => n + f.total, 0);
	if (files.length && total > 0) fraction = Math.min(0.99, files.reduce((n, f) => n + Math.min(f.done, f.total), 0) / total);
	else if (gb && step.totalGb) fraction = Math.min(0.97, Number(gb[3]) / step.totalGb);
	else if (gb) fraction = Math.min(0.97, Number(gb[1]) / Math.max(1, Number(gb[2])));
	let left;
	if (fraction && fraction > 0.04 && inStep > 20) left = inStep * (1 - fraction) / fraction;
	else left = Math.max(step.est - inStep, step.est * 0.15);
	const later = plan.slice(index + 1).reduce((n, s) => n + s.est, 0);
	const before = plan.slice(0, index).reduce((n, s) => n + s.est, 0);
	const doneInStep = fraction ? step.est * fraction : Math.min(inStep, step.est * 0.9);
	const eta = Math.round(left + later);
	return {
		steps: plan.map((s) => s.label),
		index,
		detail: state?.text ? state.text.replace(/^[^(]*\(?/, '').replace(/\)$/, '') : '',
		fraction: Math.max(0.02, Math.min(0.98, (before + doneInStep) / (before + doneInStep + eta))),
		elapsedSeconds: Math.round((now - startedAt) / 1000),
		etaSeconds: eta,
		quietSeconds: Math.round((now - changedAt) / 1000),
		files: files.map(({ name, done, total, speed }) => ({ name, done, total, speed: Math.round(speed) })),
		// Booting reports nothing for minutes; later steps report often.
		quietLimitSeconds: index === 0 ? 360 : 150
	};
}
