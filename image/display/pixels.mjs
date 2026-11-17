// The page and its pixel oracle share geometry, not a golden tied to one architecture's antialiasing.
export const WIDTH = 800;
export const HEIGHT = 600;
export const PAGE = `<!doctype html><meta charset="utf-8"><style>
body { margin:0; background:white; color:#111; font-family:"DejaVu Sans"; }
h1 { position:absolute; left:40px; top:30px; margin:0; font-size:32px; }
p { position:absolute; left:40px; top:90px; margin:0; font-size:20px; }
button { position:absolute; left:40px; top:160px; width:200px; height:50px; font:20px "DejaVu Sans"; }
#patch { position:absolute; left:40px; top:260px; width:240px; height:120px; background:#c02828; }
</style><h1>pi-dispatch display</h1><p>Chromium renders readable text.</p>
<button onclick="document.querySelector('#patch').style.background='#16834a'; this.textContent='Checked';">Check rendering</button><div id="patch"></div>`;

/** A blank PNG, an unclicked page, or a page with its text hidden is a failure even when the browser exits 0. */
export function pixelsProblem({ width, height, data }) {
	if (width !== WIDTH || height !== HEIGHT || data.length !== WIDTH * HEIGHT * 4) return "screenshot-invalid";
	const rgb = (x, y) => data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
	if (![...rgb(400, 400)].every((v) => v === 255)) return "screenshot-blank";
	for (const [x, y] of [[60, 280], [260, 360]]) {
		if (!rgb(x, y).every((v, i) => v === [22, 131, 74, 255][i])) return "screenshot-blank";
	}
	let ink = 0;
	for (let y = 30; y < 75; y++) for (let x = 40; x < 400; x++) {
		const p = rgb(x, y);
		if (p[0] < 100 && p[1] < 100 && p[2] < 100 && p[3] === 255) ink++;
	}
	return ink >= 500 && ink <= 7000 ? null : "text-not-rendered";
}
