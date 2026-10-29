/** Venue declarations are this build's table, never a probe of another host's runtime. */
import { OBSERVATION_FIX } from "@edgehero/pi-dispatch/backends";
import {
  GATEWAY_TEXT,
  OPENSHELL_UNPUBLISHED_TEXT,
  venuesView,
} from "../../read-model.mjs";
import { VENUE_LABEL } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";

const model = (view) => venuesView(view.data?.snapshot?.hostBudgets ?? []);
const selected = (view) =>
  model(view).venues.find((v) => v.name === view.query?.name);
const names = (rows) => (rows.length ? rows.join(", ") : "no live host");
const word = (p) =>
  html`<span class="vw vw--${p.word}">${ui.chip(p.word, {
    icon:
      p.word === "enforced"
        ? "shield"
        : p.word === "asserted"
          ? "done"
          : "minus",
    status:
      p.word === "enforced"
        ? "ok"
        : p.word === "asserted"
          ? "attention"
          : "idle",
  })}</span>`;
const missing = () =>
  ui.card({
    title: VENUE_LABEL,
    body: html`<p class="note">This venue is not in this build's table.</p>`,
  });
const panel = (title, fn) => (view) => {
  const v = selected(view);
  return v ? ui.card({ title, body: fn(v, model(view), view) }) : missing();
};

export const venueSummary = panel(
  "Where it runs",
  (v, m) =>
    html`<p>${v.name}: ${v.describe}.</p> <p class="note"> Declarations are this build's table. Hosts publish their setup when their worker starts; nothing here probes a host. </p> ${ui.seg(
      m.venues.map((x) => ({
        label: x.name,
        href: `/fleet/venue?${new URLSearchParams({ name: x.name })}`,
        on: x.name === v.name,
      })),
      { label: VENUE_LABEL },
    )}${ui.facts([
      ["Blessed on", names(v.blessedOn)],
      ["Default on", names(v.defaultOn)],
      ["Credentials", v.custodyText],
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
    ], { cols: 1 })}${
      m.unpublished.length
        ? html`<p class="note"> Not published by ${names(m.unpublished)} (a worker older than this console). </p>`
        : null
    }`,
);

export const venueServes = panel(
  "What it serves",
  (v) =>
    html`${ui.tbl({
      label: `${v.name} features`,
      heads: ["Feature", "Serves", "What this means"],
      rows: v.serves.map((s) => [
        s.key,
        s.word === "image" ? "with the image" : s.word,
        s.text,
      ]),
    })} <p class="note"> These say what the venue can do, not what it guarantees, so no floor compares them. A feature can still be refused before spend when the job image lacks its capabilities. </p>`,
);

export const venueProperties = panel(
  "What it declares",
  (v) =>
    html`<p class="note"> Enforced: the boundary enforces this promise. Asserted: the venue relies on the named assertion. Absent: the venue makes no such promise. </p> ${ui.tbl(
      {
        label: `${v.name} properties`,
        stack: true,
        heads: ["Property", "Word", "Who stands behind it", "Host floor"],
        rows: v.properties.map((p) => [
          html`<b>${p.label}</b><br />${p.question}<br /><span class="code" >${p.property}</span >`,
          word(p),
          html`${p.wordText}${
            p.assertedBy ? html`<p>${p.assertedBy}</p>` : null
          }${p.armedBy ? html`<p>Only while ${p.armedBy} is on.</p>` : null}${
            p.observedText
              ? html`<p> Holds where ${p.observedText}; elsewhere it counts as asserted. </p>`
              : null
          }`,
          p.flooredOn.length
            ? html`${p.flooredOn.map(
                (f) =>
                  html`<p> ${f.host} asks for ${f.want}: ${
                    f.meets
                      ? "this venue meets it"
                      : "this venue falls below it, so that host would refuse it"
                  }${
                    !v.blessedOn.includes(f.host)
                      ? "; that host does not bless it"
                      : ""
                  }. </p>`,
              )}`
            : "No published floor asks for this property",
        ]),
      },
    )}`,
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

export const venueCompare = panel(
  "Compare venues",
  (v, m) =>
    html`<div class="venue-compare venue-compare--${v.name}">${ui.tbl({
      label: "All venue declarations",
      heads: [
        "Property",
        ...m.venues.map((x) =>
          x.name === v.name
            ? html`<strong>${x.name} (this venue)</strong>`
            : x.name,
        ),
      ],
      rows: [
        ...v.properties.map((p, i) => [
          p.label,
          ...m.venues.map(
            (x) =>
              html`${word(x.properties[i])}${
                x.properties[i].armedBy
                  ? html` <span class="code">${x.properties[i].armedBy}</span>`
                  : null
              }`,
          ),
        ]),
        ...v.serves.map((s, i) => [
          s.key,
          ...m.venues.map((x) => x.serves[i].word),
        ]),
        ["Credentials", ...m.venues.map((x) => x.custodyText)],
      ],
    })}</div> <p class="note"> Enforced, asserted and absent are declarations. PI_EGRESS marks words armed only while that switch is on. </p>`,
);
