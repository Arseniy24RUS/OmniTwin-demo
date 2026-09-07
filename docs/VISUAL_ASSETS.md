# Generated presentation portraits

`apps/web/public/demo/fictional-portraits-v1.png` is a shared illustration atlas generated with the built-in imagegen tool. It is not photography, model evidence, or a unique depiction of each person. Only adult profiles use it. Its mapping, SHA-256 and provenance are in `portrait-atlas-v1.json`; the bitmap is loaded only when a profile is displayed, not by the city renderer.

The original RUDN PNG is used unmodified. No image-generated scene is used as a live map or as visual QA evidence.

## Final generation prompt

Use case: stylized-concept. Asset type: ONE shared portrait sprite atlas for an actual interactive scientific-platform demo, not a UI screenshot. Create exactly eight beautifully illustrated fictional Russian city residents, in a perfectly regular 4-column by 2-row edge-to-edge grid on a 2048x1280 landscape canvas, no gutters or gridlines. Each cell is the same 512x640 portrait area, with one head-and-shoulders portrait centered, full head including hair safely inside that cell, face at same scale. Top row from left: man age25, man age45, man age62, man age78. Bottom row: woman age25, woman age45, woman age62, woman age78. Ordinary everyday contemporary clothing, subtly different muted teal/tan/blue/ochre sweaters and shirts, believable friendly individual faces and visible age differences. Style: premium editorial digital painting, realistic-stylized and clearly illustrated rather than a photograph, natural proportions, refined brushwork, soft warm afternoon key light, delicate cool fill. All eight cells have matching dark navy/teal softly blurred background, no busy details. These are invented people, no real person likeness. No text, letters, numerals, logos, badges, borders, watermark or UI. Exactly 8 equal cells, not a collage with overlapping panels. Usable as CSS background-position sprite sheet in fictional resident profile cards.

The generated size may differ from the requested size; CSS selects proportional atlas cells and does not treat requested pixel dimensions as measured output metadata.
