# Design QA — Curator controls above Showcase image

## Evidence

- Source visual truth: `/var/folders/84/xjtqfy791lv8k__q70gmxdyw0000gn/T/codex-clipboard-94d07767-7b34-4255-bd40-a5f78dc727ea.png`
- Rendered implementation: `/tmp/ascii-camera-curator-toolbar-final.png`
- Focused implementation crop: `/tmp/ascii-camera-curator-toolbar-focused.png`
- Combined comparison: `/tmp/ascii-camera-curator-toolbar-comparison.png`
- State: Curator mode, Showcase view, removed animated image selected in the center.
- Browser viewport and implementation capture: 1280 × 633 CSS px, device scale factor 1, 1280 × 633 image pixels.
- Source image: 444 × 451 pixels. Focused implementation crop: 460 × 390 pixels. The source is a cropped bug report rather than a full viewport, so the focused comparison preserves native density and compares the central-image region instead of stretching either image.

## Full-view comparison

The final full view preserves the existing Showcase panel height, central image dimensions, side-card spacing, side-card angles, reflection layout, list position, and header controls. The only visible structural change is the Curator toolbar moving outside the central image.

## Focused-region comparison

The combined comparison shows the reported overlap on the left and the corrected state on the right. `Restore`, `.gif`, and `Delete` now occupy one row above the visible image edge. Browser geometry measured an 8 px gap from the toolbar bottom to the image top, with all three vertical centers at 130 px.

## Findings

- No remaining P0, P1, or P2 mismatch in the requested state.
- Fonts and typography: existing monospace family, capitalization, letter spacing, and control sizes are preserved.
- Spacing and layout rhythm: verified 8 px image gap across rectangle, square, and character-shaped examples; original image sizes and Showcase panel height are unchanged.
- Colors and visual tokens: Restore retains the yellow/black Curator treatment; `.gif` remains green on black; Remove/Delete remain red.
- Image quality and asset fidelity: ASCII glyph rendering, aspect ratio, masks, and original reflections are unchanged. No image assets were replaced.
- Copy and content: the permanent-delete action is labeled `Delete` in Showcase.

## Comparison history

1. P1: Curator controls overlapped the image and `.gif` was on a separate row. Fixed by moving the toolbar outside the transformed image layer and explicitly placing all controls on grid row 1.
2. P1: Showcase deletion clones inherited reflection and relative positioning, creating displaced enlarged remnants. Fixed by making all five layers absolute, co-locating them exactly with the source image, using a transparent reflection mask, hiding the static reflection during deletion, and stopping Loop playback during the fade.
3. Post-fix evidence: four aspect/shape samples measured an 8 px gap; the five fade layers measured zero x/y displacement, created no visible reflection, and were fully removed after the animation.

## Interaction checks

- Central image still opens Lightbox.
- Restore/Delete controls remain clickable without opening Lightbox.
- The Curator toolbar hides during deletion.
- No framework error overlay appeared and the page rendered non-empty content.
- Main inline script parsing and whitespace checks passed.

## Follow-up polish

No additional polish is required for this scoped correction.

final result: passed
