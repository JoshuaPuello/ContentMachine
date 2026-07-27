---
name: seedance-2-0
description: Author stable image-to-video motion prompts for ContentMachine scenes using Seedance 2.0 discipline. Use for motion-prompt generation, video regeneration, mannequin documentary shots, Grok/Veo/Kling/LTX image-to-video work, or any clip where source-frame identity, character count, wardrobe, props, visual style, and continuity must not drift.
---

# Seedance 2.0 Motion Discipline

Treat the selected source image as immutable frame zero. It defines composition, subject count, identities, mannequin material, wardrobe, props, setting, lighting, and visual style. Direct motion only; never re-imagine the frame.

## Required Prompt Architecture

1. Begin with a deterministic `SOURCE FRAME LOCK`.
2. Add deterministic `CHARACTER / STYLE LOCK`, `WARDROBE LOCK`, and `OBJECT LOCK` sections.
3. State the scene intent and the exact narration covered by this clip.
4. Choose exactly one primary camera move.
5. Write one continuous storyboard on an exact two-second grid.
6. End with a deterministic stability and negative-constraint block.

The LLM may author scene intent and motion choreography. Code must compose the locks and protected ending so a weaker model cannot omit them.

## Motion Rules

- Make one short clip, never a trailer, montage, or multi-shot sequence.
- Use one primary camera move: slow push, gentle pullback, subtle pan, slight tilt, lateral track, small orbit, rack focus, or near-locked documentary drift.
- Keep camera movement restrained. Use 10–15% motion normally and never exceed 20%.
- Add only physically plausible secondary motion already supported by the frame and scene: breathing-like body settling, fabric movement, rain, smoke, dust, water, papers, practical light, shadows, or machinery.
- Use one continuous take. Never cut, teleport, transform, swap angles, change locations, or introduce a second camera.
- Begin exactly at the selected frame. Settle into a clean stable hold at the end.
- Do not add characters, limbs, animals, props, signs, weapons, vehicles, structures, or readable text that are absent from the source frame. If the script requires an absent entity, reject the frame/prompt pairing and select or generate a compatible source image first.

## Mannequin Continuity Contract

- Preserve every visible figure as a seamless glossy porcelain mannequin for every frame.
- Porcelain is a visual surface treatment only. The figure is not a toy, statue, robot, puppet, or rigid display mannequin; it represents a living human and must move exactly like one.
- Preserve featureless faces. Never generate eyes, noses, mouths, skin pores, flesh, realistic human faces, or live-action humans.
- Preserve the exact porcelain tone, sculpted or painted hair, silhouette, clothing, footwear, accessories, and body proportions visible in the source.
- Preserve the source-frame character count. Never duplicate, remove, merge, or replace a figure.
- Keep pristine surfaces: no cracks, seams, doll joints, articulation points, melting, warping, or texture drift.
- Clothing and footwear do not appear, disappear, recolor, simplify, or change material during motion.
- A held prop remains in the same hand unless the scene explicitly choreographs a physically plausible transfer.

If no figure appears, state: `No people or human-like figures appear. Do not add a face, hand, body, silhouette, or reflection.`

## Human Biomechanics Contract

Every figure that represents a person must use natural human biomechanics, regardless of its porcelain mannequin appearance.

- Choreograph movement from a real human body: natural center of gravity, weight transfer, balance, foot planting, joint arcs, reach limits, grip mechanics, inertia, anticipation, follow-through, and recovery.
- Preserve realistic coordination between the pelvis, torso, shoulders, head, arms, hands, legs, and feet. A step shifts weight before the other foot lifts; a reach begins through the shoulder and torso; lifting or pushing shows believable effort and counterbalance.
- Respect the represented person's age, build, physical condition, injury, clothing, carried weight, terrain, and emotional state. These factors may change speed and posture, but never turn motion into toy or puppet mechanics.
- Keep motion temporally natural: purposeful actions have a readable preparation, execution, and settle. Small idle behavior should resemble subtle human breathing, postural correction, balance adjustment, or hand tension—not mechanical oscillation.
- Hands contact and manipulate objects with plausible finger placement, grip pressure, leverage, and resistance. Feet remain grounded unless the documented action physically requires a jump or fall.
- Never use robotic stiffness, hinge-only articulation, puppet-like jerks, doll motion, statue motion, synchronized limb swings, foot skating, ground sliding, floating, weightless movement, impossible balance, rubber limbs, or mechanically repeated gestures.
- The seamless porcelain surface must bend over human joint geometry without revealing seams, hinges, ball joints, or mechanical internals.

## Storyboard Grid

Create exactly one beat per two seconds. The last beat absorbs a one-second remainder: a 15-second clip ends with `SHOT 7 — 00:12–00:15`.

Each beat must specify:

- the subject's concrete physical action and small behavior, choreographed with natural human biomechanics;
- how the single camera move progresses;
- one compatible environmental motion at most;
- continuity with the previous beat.

The first beat begins at the source pose and composition. The last beat completes the important action and settles. Do not front-load every action into the first beat.

## Scene and Narration Alignment

- Animate what the supplied narration and scene description actually discuss.
- Use the segment-specific narration when a scene spans multiple clips.
- Keep the same action, location, lighting, wardrobe, props, and figure count across sequential segments.
- Advance later segments; never restart the same action.
- Use previous-scene context only when compatible with the next selected source frame. The next selected frame remains authoritative.
- Do not invent speech, lip movement, dialogue, captions, labels, UI, or text overlays. ContentMachine supplies narration separately.

## Negative Constraints

Always suppress: extra or missing figures, extra limbs, duplicate subjects, human skin, realistic human faces, facial features, identity drift, wardrobe drift, new props, object replacement, morphing, melting, cracks, seams, visible mechanical joints, robotic stiffness, puppet motion, doll motion, statue motion, foot skating, ground sliding, floating, weightless movement, impossible balance, rubber limbs, repeated mechanical gestures, cuts, montage, teleports, abrupt camera changes, readable text, subtitles, captions, UI, logos, watermark, letterboxing, and unstable edges.

## Output Discipline

For batches, return only the requested machine-readable schema. Preserve every requested scene and segment identifier exactly once. Do not return commentary or markdown fences.
