// A small, dependency-free Markdown renderer. All input is HTML-escaped before any markup
// is added, so model output can never inject tags or scripts into the page.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
	// Pull code spans out first so their contents are not treated as emphasis or links.
	const codes = [];
	let s = esc(text).replace(/`([^`\n]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
	s = s
		.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
	return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[i]}</code>`);
}

function blocks(text) {
	const out = [];
	let para = [];
	let list = null;
	const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
	const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };

	for (const line of text.split('\n')) {
		const heading = line.match(/^(#{1,3})\s+(.*)$/);
		const item = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/);
		if (heading) {
			flushPara(); flushList();
			out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
		} else if (item) {
			flushPara();
			const tag = item[1] ? 'ul' : 'ol';
			if (list && list.tag !== tag) flushList();
			list ||= { tag, items: [] };
			list.items.push(item[3]);
		} else if (!line.trim()) {
			flushPara(); flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara(); flushList();
	return out.join('');
}

export function renderMarkdown(src) {
	// Split on code fences; odd segments are code. An unclosed fence (mid-stream) still
	// lands in an odd segment, so a half-written code block renders as code.
	return String(src).split(/^```/m).map((seg, i) => {
		if (i % 2 === 0) return blocks(seg);
		const nl = seg.indexOf('\n');
		const lang = (nl === -1 ? seg : seg.slice(0, nl)).trim();
		const code = nl === -1 ? '' : seg.slice(nl + 1).replace(/\n$/, '');
		return `<pre><div class="lang"><span>${esc(lang || 'code')}</span><button type="button" class="copy">Copy</button></div><code>${esc(code)}</code></pre>`;
	}).join('');
}
