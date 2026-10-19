// Reads stdin to EOF and reports what arrived, as the in-image supervisor would.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => { console.log(JSON.stringify({ got: raw, len: raw.length, eof: true })); process.exit(Number(process.argv[2] ?? 0)); });
