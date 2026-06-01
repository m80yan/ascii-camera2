

# browser-runtime.skill.md

Shared browser and runtime behavior knowledge collected during development of:
- ASCII Camera
- FilmBase
- chibi-snake
- interactive media-heavy web applications

This file focuses on:
- browser inconsistencies
- media runtime behavior
- iframe differences
- rendering instability
- autoplay restrictions
- preview environment limitations
- deployment/runtime verification

---

# Browser Philosophy

## Runtime behavior is more important than generated code

Code may appear correct while runtime behavior is broken.

Always validate:
- actual rendering
- interaction feel
- media timing
- fullscreen behavior
- resize behavior
- GPU rendering
- camera output

Production behavior is the real source of truth.

---

## Browsers are not consistent environments

Different browsers may produce different:
- rendering behavior
- media timing
- GPU acceleration behavior
- autoplay policies
- viewport calculations
- camera processing pipelines

Never assume cross-browser consistency.

---

# Camera & Media Skills

## Browser camera pipelines may apply hidden processing

Some browser/runtime environments may automatically enable:
- background segmentation
- portrait effects
- lighting enhancement
- video cleanup
- blur systems

These effects may appear even when the application itself does not enable them.

Always verify browser-level processing first.

---

## Embedded preview environments are unreliable for media testing

Cursor preview environments may differ from standalone browsers in:
- camera rendering
- autoplay behavior
- GPU acceleration
- timing stability
- fullscreen behavior
- audio permissions

Always verify media systems in standalone browsers.

---

## Audio playback requires user interaction

Many browser audio systems require:
- user gestures
- interaction-based initialization
- media priming

Do not assume autoplay audio is stable.

Audio bugs are often browser policy issues rather than application logic.

---

## GIF and video timing may differ between browsers

Different browsers may render:
- frame timing
- playback smoothness
- decoding behavior
- GIF looping

Always verify exported media behavior across browsers.

---

# Rendering Skills

## GPU acceleration changes rendering behavior

GPU acceleration may affect:
- animation smoothness
- ASCII rendering clarity
- video timing
- CSS transforms
- canvas performance

Visual artifacts may appear only on specific rendering pipelines.

---

## Embedded rendering environments may distort performance

Preview environments inside:
- Cursor
- iframes
- embedded browsers

may not match production rendering performance.

Do not optimize purely based on embedded preview behavior.

---

## Resize calculations are fragile

Viewport calculations may differ across:
- iframe environments
- fullscreen mode
- browser zoom levels
- device pixel ratios

Always validate resize behavior dynamically.

---

# iframe Skills

## iframe environments change application behavior

Applications inside iframes may experience:
- altered viewport sizing
- fullscreen restrictions
- focus behavior changes
- autoplay restrictions
- scroll behavior differences

Do not assume iframe behavior matches standalone windows.

---

## Notion iframe behavior differs from standalone runtime

Notion embedded environments may differ in:
- viewport sizing
- fullscreen handling
- scrolling behavior
- interaction timing

Always test:
- embedded mode
- standalone mode
- opened-in-new-window mode

separately.

---

# Deployment Skills

## Local development does not guarantee production behavior

Differences may appear between:
- local dev server
- preview builds
- deployed production builds

Especially for:
- media rendering
- caching
- camera timing
- asset loading
- fullscreen transitions

Always validate deployed runtime behavior.

---

## Build frequently during media-heavy development

Media-heavy projects often accumulate hidden runtime issues.

Frequent builds help detect:
- deployment regressions
- rendering differences
- browser-specific bugs
- production-only timing issues

---

# AI Workflow Skills

## AI may misdiagnose browser-level problems as application bugs

AI frequently attempts to:
- rewrite rendering systems
- modify camera pipelines
- change application logic

when the real issue is:
- browser policy
- GPU behavior
- embedded runtime environment
- browser-level media processing

Verify runtime environment before rewriting systems.

---

## AI tends to underestimate runtime complexity

Media-heavy applications contain:
- browser inconsistencies
- rendering pipeline instability
- timing variance
- GPU-dependent behavior

Do not aggressively simplify runtime handling without testing.

---

## Real browser testing is mandatory

Never rely only on:
- static reasoning
- AI assumptions
- embedded previews
- code inspection

Always validate:
- real browsers
- deployed environments
- standalone runtime behavior
- actual interaction feel