/** Venue declarations are this build's table, never a probe of another host's runtime. */
import { OBSERVATION_FIX } from "@edgehero/pi-dispatch/backends";
import {
  GATEWAY_TEXT,
  DECLARATION_TEXT,
  OPENSHELL_UNPUBLISHED_TEXT,
  venuesView,
} from "../../read-model.mjs";
import { VENUE_LABEL } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";

const model = (view) => venuesView(view.data?.snapshot?.hostBudgets ?? []);
const selected = (view) =>
  model(view).venues.find((v) => v.name === view.query?.name);
const holderOf = (venue) =>
  venue.custody === "layer" ? "the venue's egress layer" : "the container";
const names = (rows) => (rows.length ? rows.join(", ") : "no live host");
const word = (p) =>
  html`<span class="chip vw vw--${p.word}${p.word === "enforced" ? " tone-ok" : ""}">${ui.icon(p.word === "enforced" ? "shield" : p.word === "asserted" ? "done" : "minus")}${p.word}</span>`;
const missing = () =>
  ui.card({
    title: VENUE_LABEL,
    body: html`<p class="note">This venue is not in this build's table.</p>`,
  });
const panel = (title, fn) => (view) => {
  const v = selected(view);
  return v
    ? ui.card({
        title,
        sub:
          {
            "What it declares": "this build’s table, 14 properties",
            "What it serves": "per feature",
            "OpenShell on each host": "read once, when the worker started",
            "Compare venues":
              "the same table for all four; this venue is highlighted",
          }[title] ?? null,
        flush: ["What it declares", "Compare venues"].includes(title),
        body: fn(v, model(view), view),
      })
    : missing();
};

export const venueSummary = panel(
  "Where it runs",
  (v, m, view) =>
    html`${ui.facts(
      [
        ["Blessed on", names(v.blessedOn)],
        ["Default on", names(v.defaultOn)],
        [
          "Published by",
          names(
            (view.data?.snapshot?.hostBudgets ?? [])
              .filter(
                (host) => host.backends !== null && host.backends !== undefined,
              )
              .map((host) => host.name),
          ),
        ],
        [
          "Credentials",
          html`<span class="vd-key">${ui.icon("key", { size: "sm" })}Held by ${holderOf(v)}</span><span class="note">${v.custodyText}</span>`,
        ],
        [
          "Published floors",
          m.floors.length
            ? m.floors
                .map(
                  (f) =>
                    `${f.host}: ${Object.entries(f.floor)
                      .map(([p, w]) => `${p}=${w}`)
                      .join(", ")}`,
                )
                .join("; ")
            : "No live host published a floor",
        ],
      ],
      { cols: 1 },
    )}${
      m.unpublished.length
        ? html`<p class="note"> Not published by ${names(m.unpublished)} (a worker older than this console). </p>`
        : null
    }`,
);

const SERVE_LABEL = {
  liveTranscript: "Live transcript",
  steering: "Steering",
  recovery: "Recovery",
  sandboxShell: "Sandbox shell",
};
const servesWord = (value) =>
  html`<span class="chip vw vw--${value === "yes" ? "enforced tone-ok" : value === "image" ? "asserted" : "absent"}">${ui.icon(value === "yes" ? "done" : value === "image" ? "layers" : "minus")}${value === "image" ? "with the image" : value}</span>`;
const legend = () =>
  html`<ul class="vd-decl">${["enforced", "asserted", "absent"].map((value) => html`<li>${word({ word: value })}<span>${DECLARATION_TEXT[value]}</span></li>`)}</ul>`;

export const venueServes = panel(
  "What it serves",
  (v) =>
    html`<ul class="vd-serves">${v.serves.map((s) => html`<li><span class="vd-serves__n">${SERVE_LABEL[s.key] ?? s.key}</span>${servesWord(s.word)}<span class="vd-serves__t">${s.text}</span></li>`)}</ul><p class="vd-note">These say what the venue can do, not what it guarantees, so no floor compares them. A feature can still be refused before spend when the job image lacks its capabilities.</p>`,
);

export const venueProperties = panel(
  "What it declares",
  (v) =>
    html`${legend()}<div class="vd-tbl">${ui.tbl({
      label: `${v.name} properties`,
      stack: true,
      heads: ["Property", "Word", "Who provides it"],
      rows: v.properties.map((p) => [
        html`<span class="vd-p"><b>${p.label}</b><span class="reason">${p.question}</span><span class="vd-key"><span class="code">${p.property}</span></span></span>`,
        word(p),
        html`<span class="vd-mean">${p.word === "asserted" && p.assertedBy ? html`Asserted by ${p.assertedBy}.` : p.wordText}</span>${p.armedBy ? html`<span class="vd-by">Only while ${p.armedBy} is on.</span>` : null}${p.observedText ? html`<span class="vd-by">Holds where ${p.observedText}; elsewhere it counts as asserted.</span>` : null}${p.flooredOn.map((f) => html`<span class="${f.meets ? "vd-by" : "vd-floorl"}">${f.meets ? ui.icon("done", { size: "sm" }) : ui.icon("attention", { size: "sm" })}<span>${f.host} asks for ${f.want}; on this host the venue has ${f.have ?? p.word}: ${f.meets ? "this venue meets it" : "this venue falls below it, so that host would refuse it"}${!v.blessedOn.includes(f.host) ? "; that host does not bless it" : ""}.</span></span>`)}`,
      ]),
    })}</div>`,
);

export const venueHosts = panel("OpenShell on each host", (v) =>
  v.openshell === null
    ? html`<p>This venue runs no gateway.</p>`
    : ui.tbl({
        label: `${v.name} gateways`,
        stack: true,
        heads: ["Host", "Engine", "Modes", "Gateway when the worker started"],
        rows: v.openshell.map((o) => [
          html`<a href="${`/fleet/host?${new URLSearchParams({ name: o.host })}`}" >${o.host}</a >`,
          o.unpublished
            ? OPENSHELL_UNPUBLISHED_TEXT
            : (o.engine ?? "not published"),
          o.modes?.join(", ") || "none published",
          o.unpublished
            ? OPENSHELL_UNPUBLISHED_TEXT
            : (GATEWAY_TEXT[o.gateway] ?? GATEWAY_TEXT.unknown),
        ]),
        empty: "No live host blesses this venue.",
      }),
);

export const venueFix = panel(
  "When an observation does not hold",
  (v, _m, view) => {
    const properties = v.properties.filter((p) => p.observedBy);
    return properties.length
      ? html`${properties.map(
          (p) =>
            html`<h3>${p.label}</h3> <p> ${p.observedText}. Where this does not hold, the word drops to asserted and a floor asking for enforced refuses. </p> <p> ${
              OBSERVATION_FIX[p.observedBy] ??
              "Check the host's runtime setup and run doctor there."
            } </p> ${
              view.role === "operator" &&
              p.observedBy === "openshellGatewayLocal"
                ? ui.cmd([
                    "openshell",
                    "gateway",
                    "add",
                    "https://127.0.0.1:17670",
                    "--local",
                  ])
                : null
            }`,
        )}`
      : html`<p>This venue's words depend on no host observation.</p>`;
  },
);

export const venueCompare = panel("Compare venues", (v, m) => {
  const cells = (render) =>
    m.venues.map(
      (x, index) =>
        html`<td class="vd-c${x.name === v.name ? " vd-cur" : ""}">${render(x, index)}</td>`,
    );
  return html`<div class="venue-compare venue-compare--${v.name} vd-cmp"><div class="tbl-wrap"><table class="tbl" aria-label="All venue declarations"><thead><tr><th scope="col">Property</th>${m.venues.map((x) => html`<th scope="col" class="vd-c${x.name === v.name ? " vd-cur" : ""}"><span class="code">${x.name}${x.name === v.name ? " (this venue)" : ""}</span></th>`)}</tr></thead><tbody>${v.properties.map((p, i) => html`<tr><td class="vd-p">${p.label}${p.armedBy ? html` <span class="faint">· ${p.armedBy}</span>` : null}</td>${cells((x) => word(x.properties[i]))}</tr>`)}<tr class="vd-split"><td class="vd-p"><b>It serves</b></td>${cells(() => html``)}</tr>${v.serves.map((s, i) => html`<tr><td class="vd-p">${SERVE_LABEL[s.key] ?? s.key}</td>${cells((x) => servesWord(x.serves[i].word))}</tr>`)}<tr><td class="vd-p">Credentials held by</td>${cells((x) => html`<span class="vd-key">${ui.icon("key", { size: "sm" })}${holderOf(x)}</span>`)}</tr></tbody></table></div></div><div class="vd-legend"><span>${word({ word: "enforced" })}the boundary enforces it</span><span>${word({ word: "asserted" })}the named assertion provides it</span><span>${word({ word: "absent" })}not provided</span><span>PI_EGRESS marks words armed only while that switch is on.</span></div>`;
});
