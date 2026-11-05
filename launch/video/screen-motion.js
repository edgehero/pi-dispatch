/**
 * What the film shows of a real console page: one card at a time, large, on an empty canvas. This runs inside the page, with the
 * console's own markup, stylesheet and dark theme and nothing redrawn. Everything else on the page is hidden rather than removed,
 * so what remains stays where the console's layout put it, and the card's own small print is taken out, because a viewer gets a
 * few seconds and one idea. A count that moves ends on the number the page already held.
 *
 * `filmScreen.seek(b)` puts the page in its state at beat `b`, as a pure function of `b`, so a frame can be rendered in any order.
 * Styles are set through the CSSOM, which the console's CSP allows, because `style=` attributes are what it refuses.
 */
(() => {
	"use strict";
	const clamp = (x) => Math.max(0, Math.min(1, x));
	const ease = (x) => 1 - (1 - clamp(x)) ** 3;
	const one = (selector, root = document) => root.querySelector(selector);
	const all = (selector, root = document) => [...root.querySelectorAll(selector)];
	/** The frame in the layout's own pixels, less the band the film's words sit in. */
	const FRAME = { width: 1440, height: 810, band: 142 };

	function enter(el, b, at, { length = 0.6, rise = 26 } = {}) {
		if (!el) return;
		const q = ease((b - at) / length);
		el.style.opacity = String(q);
		el.style.transform = q >= 1 ? "" : `translateY(${(1 - q) * rise}px)`;
	}

	function count(el, b, at, { length = 1.2, from = 0 } = {}) {
		if (!el) return;
		if (!el.filmCount) {
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const match = node.nodeValue.match(/^(\D*)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
				if (!match) continue;
				el.filmCount = { node, before: match[1], value: Number(match[2].replaceAll(",", "")), places: match[2].split(".")[1]?.length ?? 0, after: match[3] };
				break;
			}
		}
		const held = el.filmCount;
		if (!held) return;
		const now = from + (held.value - from) * ease((b - at) / length);
		held.node.nodeValue = `${held.before}${now.toFixed(held.places)}${held.after}`;
	}

	function grow(rect, b, at, length = 0.9) {
		if (!rect) return;
		if (rect.filmWidth === undefined) rect.filmWidth = Number.parseFloat(rect.getAttribute("width"));
		rect.setAttribute("width", `${(rect.filmWidth * ease((b - at) / length)).toFixed(2)}%`);
	}

	/** Words appear in reading order, holding their places so the card does not reflow. */
	function words(el, b, at, perBeat) {
		if (!el) return;
		if (!el.filmWords) {
			el.filmWords = [];
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			const nodes = [];
			for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.trim()) nodes.push(node);
			for (const node of nodes) {
				const holder = document.createDocumentFragment();
				for (const part of node.nodeValue.split(/(\s+)/)) {
					if (!part.trim()) {
						holder.append(part);
						continue;
					}
					const span = document.createElement("span");
					span.textContent = part;
					holder.append(span);
					el.filmWords.push(span);
				}
				node.replaceWith(holder);
			}
		}
		el.filmWords.forEach((span, i) => {
			span.style.opacity = String(clamp((b - at) * perBeat - i + 1));
		});
	}

	function type(field, text, b, at, perBeat) {
		if (field) field.value = text.slice(0, Math.max(0, Math.floor((b - at) * perBeat)));
	}

	function holdAnimations(b) {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = b * 400;
		}
	}

	const hide = (...els) => {
		for (const el of els) if (el) el.style.display = "none";
	};
	/** A card's children, less all but what `keep` matches: the small print goes, and the card closes up around the rest. */
	const trim = (card, keep) => {
		for (const child of card.children) if (!child.matches(keep)) hide(child);
	};

	/**
	 * Only these are visible. Hidden, not removed, so everything stays where the console laid it out. Set on the body and inherited,
	 * because setting it on every element also hides the sprite's symbols, and with them every icon drawn from the sprite.
	 */
	let shownNow = [];
	function only(...els) {
		document.body.style.visibility = "hidden";
		for (const el of shownNow) el.style.visibility = "";
		for (const el of els) el.style.visibility = "visible";
		shownNow = els;
	}

	/** Where the camera sits for these elements to fill `width` of the layout, centred above the words. */
	function aim(els, width, band = FRAME.band) {
		const boxes = els.map((el) => el.getBoundingClientRect());
		const left = Math.min(...boxes.map((box) => box.left));
		const right = Math.max(...boxes.map((box) => box.right));
		const top = Math.min(...boxes.map((box) => box.top));
		const bottom = Math.max(...boxes.map((box) => box.bottom));
		const scale = width / (right - left);
		return { scale, x: (left + right) / 2 - FRAME.width / 2 / scale, y: (top + bottom) / 2 - (FRAME.height - band) / 2 / scale };
	}
	/** A CSS transform is drawn again at its own scale, so type stays sharp, which scaling a finished screenshot would not. */
	function camera({ scale, x, y }, push = 1) {
		const s = scale * push;
		const cx = x + FRAME.width / 2 / scale;
		const cy = y + (FRAME.height - FRAME.band) / 2 / scale;
		document.body.style.transformOrigin = "0 0";
		document.body.style.transform = `translate(${-(cx - FRAME.width / 2 / s) * s}px, ${-(cy - (FRAME.height - FRAME.band) / 2 / s) * s}px) scale(${s})`;
	}

	const PROGRAMS = {
		/** Three cards, and the big number on each. */
		overview: {
			setup() {
				const cards = ["#p-needs", "#p-active", "#p-spend"].map((id) => one(id));
				hide(one("#p-waiting"));
				const row = cards[0].parentElement;
				row.style.gridTemplateColumns = "repeat(3, 1fr)";
				row.style.width = "760px";
				for (const section of cards) trim(one(".card", section), ".card__head, .bigpair, .kpi");
				only(...cards);
				this.cards = cards;
				this.view = aim(cards, 1320);
			},
			seek(b) {
				camera(this.view, 1 + 0.012 * b);
				this.cards.forEach((card, i) => enter(card, b, i * 0.5));
				all(".big__n").forEach((n) => count(n, b, 0.1, { length: 1 }));
				all(".kpi b").forEach((n, i) => count(n, b, 0.5 + i * 0.5, { length: 1.2 }));
			},
		},

		/** The hosts, each with its slots: several machines, one list. */
		machines: {
			setup() {
				const section = one("#p-hosts");
				const card = one(".card", section);
				section.style.width = "560px";
				hide(one(".card__sub", card));
				this.rows = all(".hostrow", card);
				for (const row of this.rows) {
					hide(one(".hostrow__beat", row), one(".hostrow__p", row), one(".hostrow__x", row));
					row.style.display = "flex";
					row.style.alignItems = "center";
					row.style.gap = "14px";
					one(".sls", row).style.marginLeft = "auto";
				}
				only(section);
				this.card = card;
				this.view = aim([card], 1040);
			},
			seek(b) {
				camera(this.view, 1 + 0.006 * b);
				enter(this.card, b, 0, { length: 0.4 });
				this.rows.forEach((row, i) => {
					enter(row, b, 0.3 + i * 0.7, { rise: 18 });
					all(".sl--run, .sl--hold", row).forEach((slot, n) => {
						slot.style.opacity = b >= 0.7 + i * 0.7 + n * 0.25 ? "1" : "0";
					});
				});
			},
		},

		/** The models in use, and the page's word for each. Two are enough to say more than one. */
		models: {
			setup() {
				const section = one("#p-models");
				const card = one(".card", section);
				section.style.width = "560px";
				hide(one(".card__sub", card));
				const rows = all(".md-m", card);
				hide(...rows.slice(2));
				this.rows = rows.slice(0, 2);
				for (const row of this.rows) hide(...all("small, .md-windows", row));
				only(section);
				this.card = card;
				this.view = aim([card], 1040);
			},
			seek(b) {
				camera(this.view, 1 + 0.006 * b);
				enter(this.card, b, 0, { length: 0.4 });
				this.rows.forEach((row, i) => enter(row, b, 0.4 + i * 1, { rise: 18 }));
			},
		},

		/** Three rules, as the page reads them: when this happens, it runs that. */
		rules: {
			setup() {
				const schedule = one("#p-tr-schedule");
				const github = one("#p-tr-github");
				const keep = [all(".tr", schedule)[0], ...all(".tr", github).slice(0, 2)];
				for (const section of [schedule, github]) {
					// Narrow, so the same width of frame holds larger type.
					section.style.width = "690px";
					hide(one(".card__head", section));
					for (const row of all(".tr", section)) if (!keep.includes(row)) hide(row);
				}
				for (const row of keep) {
					hide(one(".tr-n", row), one(".tr-status", row), one(".tr-open", row), ...all(".tr-sub, .tr-chips, .tr-note, .tr-k", row));
					row.style.display = "flex";
					row.style.alignItems = "center";
					row.style.gap = "18px";
					row.style.padding = "22px 26px";
					one(".tr-then", row).style.marginLeft = "auto";
				}
				only(schedule, github);
				this.rows = keep;
				this.view = aim([schedule, github], 1240);
			},
			seek(b) {
				camera(this.view, 1 + 0.004 * b);
				this.rows.forEach((row, i) => enter(row, b, i * 0.9, { rise: 18 }));
			},
		},

		/** The steer box and nothing else: one sentence typed into a running job. */
		steer: {
			setup() {
				const section = one("#p-chat");
				const card = one(".card", section);
				trim(card, "form:first-of-type");
				only(section);
				this.card = card;
				this.field = one("textarea", card);
				this.button = one("button", card);
				this.field.rows = 2;
				this.view = aim([card], 900);
			},
			seek(b) {
				camera(this.view, 1 + 0.01 * b);
				enter(this.card, b, 0, { length: 0.4 });
				type(this.field, "Leave the payments reader for a later pull request.", b, 0.2, 23);
				this.field.style.outline = b >= 0.2 ? "2px solid var(--focus)" : "";
				const sent = b >= 2.5;
				this.button.style.background = sent ? "var(--primary)" : "";
				this.button.style.color = sent ? "var(--on-primary)" : "";
			},
		},

		/** The agent's first sentence, and the answer. The rest of its long question is the console's to show, not a film's. */
		question: {
			setup() {
				const card = one(".qcard");
				hide(one(".qcard__meta", card), one(".card__sub", card), one(".qcard__wait", card));
				const text = one("[data-run-question]", card);
				text.textContent = text.textContent.split(/\n\s*\n/)[0];
				for (const note of all(".qform__act ~ *, .qform p", card)) hide(note);
				const answer = one("#run-answer", card);
				answer.rows = 2;
				// Narrow, so the same width of frame holds larger type.
				card.style.width = "640px";
				only(card);
				this.card = card;
				this.text = text;
				this.answer = answer;
				this.view = aim([card], 1160);
			},
			seek(b) {
				camera(this.view, 1 + 0.004 * b);
				enter(this.card, b, 0);
				words(this.text, b, 0.3, 12);
				type(this.answer, "A, with its own small limit on retries.", b, 3, 15);
				this.answer.style.outline = b >= 2.8 ? "2px solid var(--focus)" : "";
			},
		},

		/** One number falling over time, then one line per project with the page's own words for it. */
		zero: {
			setup() {
				const rate = one("#p-zt-rate");
				const rateCard = one(".card", rate);
				trim(rateCard, ".card__head, .kpi, svg");
				rate.style.width = "420px";
				const projects = one("#p-zt-projects");
				const card = one(".card", projects);
				card.style.width = "760px";
				trim(card, ".zt-tbl");
				hide(one(".zt-row--head", card));
				const rows = all("summary.zt-row", card);
				hide(rows.at(-1)?.closest("li"));
				this.rows = rows.slice(0, -1);
				for (const row of this.rows) {
					row.style.gridTemplateColumns = "170px 1fr";
					hide(one(".zt-chev", row), one(".zt-tr", row), one(".zt-n", row), one(".zt-st", row), one(".zt-c", row), one(".zt-name small", row));
				}
				this.rate = rate;
				this.projects = projects;
				this.rateView = aim([rateCard], 840, 177);
				this.listView = aim([card], 1160, 177);
				this.shown = null;
			},
			seek(b) {
				const list = b >= 3;
				if (this.shown !== list) {
					only(list ? this.projects : this.rate);
					this.shown = list;
				}
				if (!list) {
					camera(this.rateView, 1 + 0.008 * b);
					enter(this.rate, b, 0);
					// Down from where it started: the page's own series begins at 31%.
					count(one(".kpi b", this.rate), b, 0.2, { length: 2.4, from: 31 });
					const spark = one(".zt-spark__l");
					if (spark) {
						const length = spark.getTotalLength();
						spark.style.strokeDasharray = String(length);
						spark.style.strokeDashoffset = String(length * (1 - ease((b - 0.2) / 2.4)));
						// The dot marks now, so it arrives with the line.
						for (const dot of all("circle", spark.ownerSVGElement)) dot.style.opacity = b >= 2.4 ? "1" : "0";
					}
					return;
				}
				camera(this.listView, 1 + 0.004 * (b - 3));
				this.rows.forEach((row, i) => {
					grow(one(".pbar__fill", row), b, 3.1 + i * 0.3);
					count(one(".zt-mv b", row), b, 3.1 + i * 0.3, { length: 0.9 });
					enter(row, b, 3 + i * 0.3, { rise: 16 });
				});
				const low = this.rows.find((row) => row.textContent.includes("Under goal"));
				if (low) {
					low.style.outline = b >= 5 ? "3px solid var(--ok)" : "";
					low.style.outlineOffset = "-3px";
					low.style.borderRadius = "14px";
				}
			},
		},
	};

	let program = null;
	window.filmScreen = {
		setup(name) {
			program = PROGRAMS[name];
			if (!program) throw new Error(`no motion for the screen ${name}`);
			document.documentElement.style.overflow = "hidden";
			document.documentElement.style.scrollBehavior = "auto";
			window.scrollTo(0, 0);
			program.setup();
			return true;
		},
		seek(b) {
			holdAnimations(b);
			program.seek(b);
			return true;
		},
	};
})();
