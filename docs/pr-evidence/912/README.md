# Timeline styling evidence for issue 912

All images are actual browser captures of the console, using sample data.

Sparse overview fixture, captured at 1440 and 375 CSS pixels in both themes:

* original: pre-library timeline, commit 78840742.
* regressed: PR 910 as present on main at db36d3d6.
* restored: fix/timeline-original-style for issue 912.

Dense fixture: 10,000 archived runs, including 250 overlapping runs in the dense project, at 1440 and 390 CSS pixels in Europe/Amsterdam. Original and regressed captures are the existing issue 907 evidence (commit 6accd1ca9de269e5b7f2af4e88e896be49948fc5). Restored captures use the same fixture. Each version retains its own default time window and layout; these are visual comparisons, not pixel diffs. The additional 3h captures show the restored pills at a closer zoom.

The interaction GIF records horizontal panning, zoom, Now, dense expansion, keyboard inspection, opening a run and returning with Back. It was captured in Chromium at 1280 CSS pixels, then encoded at 1000 pixels wide and seven frames per second. The README images in the implementation branch show the full overview page.
