---
name: faceless-scripts-os
description: Write, rewrite, route, and audit fluent faceless documentary narration for ContentMachine, including trailer hooks, chapter overviews, chapter transitions, scene voiceover, humanization, retention, niche structure, and TTS-readiness. Use whenever documentary scripts feel choppy, robotic, repetitive, stitched together, or need a genre-specific writing approach.
---

# ContentMachine Faceless Scripts OS

Treat the narration as one spoken documentary divided across production units, never as independent captions written scene by scene.

## Workflow

1. Read `references/contentmachine-documentary-runtime.md` for every narration task.
2. Classify the story and load only the relevant references from the routing table.
3. Draft one continuous spoken script using the complete story and scene plan.
4. Partition the finished prose into trailer, overview, transition, and scene units at natural thought boundaries.
5. Read the complete playback sequence aloud in its final order.
6. Run the H17/staccato and greenlight audits. Rewrite until clean.

## Reference routing

| Situation | Read |
|---|---|
| Every script | `faceless-scripts-os-master.md`, `voice-anchoring-skill.md`, `humanizer-skill.md`, `retention-mechanics-skill.md`, `script-structures-skill.md`, `variety-rotation-skill.md`, `greenlight-audit-skill.md` |
| Trailer enabled | `REAL-FACELESS-HOOK-SWIPE.md`, then `NICHE-SPECIFIC-HOOKS.md` for the detected niche |
| Prison escape, crime, heist, disappearance, investigation | `true-crime-skill.md` |
| Biography, survival, rescue, transformation, rise/fall | `heros-journey-skill.md` |
| Celebrity or influencer story | `celebrity-documentary-skill.md` |
| Ending or CTA work | `outro-psychology-skill.md` |
| Packaging, title, metadata, thumbnail | `packaging-skill.md`, `title-formulas-skill.md` |
| Research or factual angle selection | `research-and-ideation-skill.md` |
| Existing retention analytics | `retention-coaching-skill.md` |
| Traditional editor cues | `visual-scripting-skill.md` |
| Model/workflow selection | `model-selection-guide-skill.md` |
| Pre-publication originality/safety | `authenticity-audit-skill.md` and `greenlight-audit-skill.md` |

The ContentMachine runtime is clean spoken TTS prose inside structured JSON. Do not copy Traditional-mode visual cues into spoken lines. Audio cues remain separate array items.

## Non-negotiable continuity rules

- Write the master narration before assigning text to units.
- Make every unit sound connected to what the listener just heard and what comes next.
- Integrate chapter titles grammatically; never recite them as title cards.
- Make the chapter overview units form one coherent preview paragraph in sequence.
- Make each chapter transition bridge the previous spoken beat into the chapter's first scene.
- Keep complete sentences intact. Do not cut one sentence across audio units.
- Reject H17 Movie Trailer, Wise Narrator, Staccato-Robotic, and Reading-Not-Speaking shapes.
- Never use rhythm-only fragment stacks such as `One tunnel. One hole. One man.`
- Use a short sentence only as an earned contrast surrounded by flowing prose.
- Preserve the jolt, proof, and tension when humanizing. Translate the register; do not weaken the story.
- Use no em dashes in spoken copy.

## Validation

Run `references/trailer-voice-scan.py` for standalone script audits. For platform changes, also run the backend narration continuity tests. A script does not pass while hard bans, staccato clusters, incomplete cinema units, or broken playback transitions remain.
