

# ASCII-CAMERA.skill.md

Project-level AI collaboration and production knowledge for ASCII Camera.

This file documents:
- retro terminal interaction philosophy
- browser camera/runtime behavior
- ASCII rendering constraints
- matrix rain timing behavior
- GIF/video workflow lessons
- gallery sync behavior
- AI workflow constraints discovered during production

---

# UX Philosophy Skills

## ASCII Camera should feel like a retro machine

ASCII Camera is not a modern social media camera app.

Avoid:
- clean SaaS-style UI
- modern minimal mobile-app aesthetics
- overly polished interaction patterns
- generic camera layouts

Prefer:
- retro terminal atmosphere
- experimental interface feeling
- imperfect analog energy
- hacker-tool aesthetics
- machine-like interaction pacing

---

## The interface should feel alive

ASCII Camera should feel:
- reactive
- slightly unstable
- computational
- screen-based
- atmospheric

Avoid interfaces that feel sterile or overly optimized.

---

# ASCII Rendering Skills

## Readability matters more than raw density

ASCII rendering should preserve:
- silhouette readability
- contrast clarity
- recognizable structure

Avoid:
- excessive visual noise
- unreadable density
- over-detailed ASCII output

Readable low-resolution output is preferable to noisy high-density output.

---

## Different resolutions require different visual balance

ASCII density changes emotional feel.

Lower resolutions:
- feel retro
- feel readable
- feel graphic

Higher resolutions:
- increase detail
- increase visual noise
- reduce silhouette clarity

Balance readability against detail.

---

## Matrix rain should feel atmospheric, not decorative

Matrix rain is part of interface identity.

Prefer:
- tight line spacing
- readable rhythm
- believable terminal motion
- visual continuity

Avoid:
- random decorative particle behavior
- inconsistent density
- noisy symbol distribution

---

# Camera & Browser Skills

## Browser camera behavior differs across environments

Camera behavior may differ across:
- Chrome
- Safari
- Arc
- embedded preview environments
- Cursor preview windows

Always verify real runtime behavior before debugging application logic.

---

## Browser-level video effects may interfere with rendering

Some browser/runtime environments may automatically enable:
- background segmentation
- portrait effects
- video enhancement systems

Verify browser-level media effects before debugging rendering pipelines.

---

## Audio playback requires user interaction

Browser audio systems often require:
- direct user gesture
- interaction-based audio priming

Do not assume autoplay audio behavior is stable.

---

## Embedded preview environments are unreliable for media testing

Cursor preview environments may not match:
- standalone browser rendering
- production deployment behavior
- camera timing
- autoplay restrictions

Always test camera systems in standalone browsers.

---

# GIF & Video Skills

## GIF rendering should prioritize motion readability

Readable motion is more important than:
- maximum frame density
- excessive visual detail
- high-frequency animation

Avoid motion that becomes visually noisy after ASCII conversion.

---

## Progress indicators should communicate recording state clearly

Recording UI should make users immediately understand:
- whether recording is active
- recording duration
- current capture state

Avoid ambiguous recording feedback.

---

## Retake flow reduces interaction anxiety

Retake systems improve:
- experimentation freedom
- user confidence
- playful interaction

Do not force immediate publishing decisions.

---

# Gallery & Social Skills

## Gallery interaction should feel lightweight

Gallery systems should feel:
- frictionless
- anonymous-friendly
- playful
- exploratory

Avoid:
- account-heavy interaction flows
- aggressive social mechanics
- overly formal publishing systems

---

## Anonymous auth should remain invisible

Anonymous login systems should:
- avoid interrupting first interaction
- avoid visible login friction
- initialize silently

Authentication should not dominate the experience.

---

## Shared gallery systems require sync stability

Gallery consistency depends on:
- stable identity logic
- reliable sync timing
- predictable delete behavior
- backward-compatible storage structure

Changes to storage systems may affect:
- likes
- ownership
- deletion visibility
- gallery consistency

---

# AI Workflow Skills

## AI tends to modernize retro interfaces

AI models naturally drift toward:
- clean modern UI
- minimal dashboard aesthetics
- generic mobile camera patterns
- standardized interaction systems

Protect:
- retro terminal feel
- ASCII atmosphere
- imperfect visual texture
- machine-like pacing
- experimental interface energy

---

## AI may over-optimize visual noise

ASCII Camera intentionally contains:
- visual texture
- roughness
- atmospheric density
- computational artifacts

Do not over-clean the interface.

Some roughness is intentional.

---

## Animation pacing affects emotional tone

Fast motion makes the interface feel:
- modern
- app-like
- polished

Slightly slower pacing helps preserve:
- terminal atmosphere
- retro machine feeling
- cinematic computational mood

---

# Runtime & Deployment Skills

## Build and deploy frequently

Media-heavy applications often behave differently between:
- local development
- preview environments
- deployed production builds

Always verify deployed behavior.

---

## Browser rendering differences matter

ASCII rendering, camera timing, and GIF playback may differ across:
- rendering engines
- GPU acceleration behavior
- browser video pipelines

Always validate visual consistency across browsers.