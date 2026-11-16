import { html } from "./html.mjs";

/** The server owns the controls and the initial projection; the library only enhances this panel. */
export function libraryTimelineHtml(seed) {
  return html`<div data-timeline-seed="${encodeURIComponent(JSON.stringify(seed))}" hidden></div>
<div class="run-timeline" data-timeline-app hidden>
  <div class="rt-topline">
    <div class="projseg rt-projects" data-rt-project-chips role="group" aria-label="Project"></div>
    <div class="rt-views">
      <div class="seg" role="group" aria-label="Rows"><button type="button" data-rt-rows="project" aria-pressed="true">Project</button><button type="button" data-rt-rows="host" aria-pressed="false">Host</button></div>
      <div class="seg" role="group" aria-label="Zoom"><button type="button" data-rt-preset="3600000" aria-pressed="false">1h</button><button type="button" data-rt-preset="10800000" aria-pressed="false">3h</button><button type="button" data-rt-preset="86400000" aria-pressed="true">24h</button></div>
    </div>
  </div>
  <div class="rt-toolbar">
    <form data-rt-project><label>Project <input name="project" value="${seed.project ?? ""}" placeholder="All projects" list="rt-projects" maxlength="32" pattern="[a-z][a-z0-9-]{0,31}"></label><datalist id="rt-projects"></datalist><button class="btn btn--sm" type="submit">Show</button></form>
    <div class="rt-actions"><button class="btn btn--sm btn--ghost" data-rt-action="older" aria-label="Pan earlier">←</button><button class="btn btn--sm btn--ghost" data-rt-action="newer" aria-label="Pan later">→</button><button class="btn btn--sm btn--ghost" data-rt-action="in" aria-label="Zoom in">+</button><button class="btn btn--sm btn--ghost" data-rt-action="out" aria-label="Zoom out">−</button><button class="btn btn--sm" data-rt-action="now">Now</button><button class="btn btn--sm btn--ghost" data-rt-action="expand" aria-expanded="false">Expand</button></div>
    <label>Window <select data-rt-span><option value="custom" disabled>Custom</option><option value="3600000">1 hour</option><option value="10800000">3 hours</option><option value="21600000">6 hours</option><option value="86400000">1 day</option><option value="604800000">1 week</option><option value="2419200000">4 weeks</option></select></label>
  </div>
  <div class="rt-orientation"><strong data-rt-range></strong><span data-rt-zone></span><span class="chip" data-rt-mode>Live</span></div>
  <p class="rt-help">Drag to explore · Scroll sideways through time · Ctrl + wheel to zoom · Arrow keys to inspect runs</p>
  <div class="rt-content"><div class="rt-chart" data-rt-chart tabindex="0" role="region" aria-label="Run timeline. Left and right select runs, up and down change project. Enter opens details."></div><aside class="rt-preview" data-rt-preview hidden aria-label="Selected run"></aside></div>
  <div class="rt-footer"><p role="status" data-rt-status>Reading retained history…</p><button class="btn btn--sm btn--ghost" data-rt-action="retry" hidden>Retry</button><button class="btn btn--sm btn--ghost" data-rt-action="previous" hidden>Previous run</button><button class="btn btn--sm" data-rt-action="more" hidden>More runs in this range</button></div>
  <div class="rt-density" data-rt-density hidden><span></span><button class="btn btn--sm" data-rt-action="back-page">Previous runs</button><button class="btn btn--sm" data-rt-action="next-page">Next runs</button><button class="btn btn--sm" data-rt-action="all-groups">All projects</button></div>
  <details class="rt-list"><summary>Runs as a list</summary><ol data-rt-list></ol></details>
</div>`;
}
