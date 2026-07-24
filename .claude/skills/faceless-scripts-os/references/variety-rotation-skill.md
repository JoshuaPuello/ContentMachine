---
name: variety-rotation
description: Anti-repetition rotation system for FacelessOS. Prevents samey scripts by rotating transitions, rehooks, context bridges, mid-CTA returns, commentary lines, foreshadowing, and section closers. Claude must select ONE option from each relevant bank and log selections at the end of the script.
---

# Variety Rotation System

> Originally created by Joey Sergio. Refined for FacelessOS v4. Guardrails added in v5.

> **MANDATORY:** Before writing ANY script, consult this file. After writing, log which rotation numbers were used. The user tracks these across sessions to prevent repetition.

## How This Works

Every script has ~8 mechanical "slots" where Claude defaults to the same phrasing. This file provides **numbered rotation banks** for each slot. Claude MUST:

1. Pick ONE number from each relevant bank per script
2. Never reuse the same combination across consecutive scripts
3. Log all selections in a **Rotation Log** at the end of the script output

If the user provides a previous Rotation Log, Claude must avoid those exact numbers.

---

## Rotation Guardrails (v5)

Three rules sit on top of every bank in this file. Rotation only works inside them.

**1) Rotation is not a quality pass.** Rotation prevents template-blur across scripts. It does not license a weak hook. The niche-viral bar is a separate, independent check, and every hook has to clear it on its own: tension planted in the first line, proof before biography, a jolt instead of homework. If your strongest opening move collides with the rotation log, sharpen that move until it reads distinct rather than downgrading to a novel-but-flat option. Benchmark hooks against REAL-FACELESS-HOOK-SWIPE.md and NICHE-SPECIFIC-HOOKS.md, then run the finished hook through the shape test in voice-anchoring-skill.md.

**2) Channel-library diff.** Before finalizing, pull the openings of your last 2-3 uploads and compare. The new hook must open on a DIFFERENT move and a DIFFERENT through-concept, not just different wording. Swapping the surface phrasing while keeping the same opening move is still repetition, because the viewer hears the move, not the words. If the move matches a recent upload, switch to a different opening move entirely.

**3) No hard-banned phrases in any bank.** No rotation option in this file, and no line you build from one, may contain a phrase on the HARD_BAN list in trailer-voice-scan.py (the dive-in and jump-in openers, the kicker line, the slop vocabulary, the metaphor-plus-landscape family). Those bans are machine-enforced with zero adjudication. If you ever spot one inside a bank option, replace the option with a clean equivalent before using it, then run the scanner over every finished script.

---

## SLOT 1: THE CONTEXT BRIDGE (After Hook → Into Background)

This is the transition from your hook into the backstory/context section. The default AI crutch is: *"To understand why, you have to understand..."* or *"But to understand how we got here, we need to go back to..."*

### Rotation Bank (Pick ONE per script)

**1A: The Rewind**
Drop straight into the past with a time/place anchor. No meta-narration about "understanding."
```
It was [YEAR], and [SUBJECT] was [doing something specific in a specific place].
```

**1B: The Contrast Drop**
Show who they were BEFORE, letting the contrast with the hook speak for itself.
```
[NUMBER] years before [hook event], [SUBJECT] was [mundane/opposite reality].
[Specific grounding detail.]
```

**1C: The "Nobody Saw It Coming" Bridge**
Frame the backstory as the thing nobody was paying attention to.
```
Nobody was paying attention to [SUBJECT] back then. [Why they were invisible/unknown.]
That was about to change.
```

**1D: The Thematic Bridge**
Connect the hook to the backstory through a theme, not a meta-instruction.
```
But this story doesn't start with [the hook event]. It starts with [thematic origin].
```

**1E: The Question Pivot**
Turn the curiosity gap from the hook into a direct question that frames the backstory.
```
How does someone go from [origin state] to [hook state]?
[Go straight into the first backstory beat.]
```

**1F: The Cold Cut**
No bridge at all. Just hard-cut to the backstory with a date or location stamp.
```
[LOCATION], [YEAR].
[First backstory sentence, no preamble.]
```

**1G: The Witness Frame**
Start the backstory through someone else's eyes.
```
If you'd asked anyone in [LOCATION] about [SUBJECT] back in [YEAR], they would have told you [perception]. They had no idea.
```

**1H: The Irony Seed**
Plant a detail from the backstory that becomes ironic given the hook.
```
[SUBJECT]'s [early detail] would later become the exact thing that [caused/destroyed/defined the hook event]. But in [YEAR], it was just [innocent framing].
```

---

## SLOT 2: REHOOKS (Every 60-90 Seconds)

These are the micro-tension lines that keep viewers watching. The defaults are: *"But this was just the beginning," "What happened next changed everything," "However, this was only the tip of the iceberg."*

### Rotation Bank: Escalation Rehooks (Pick 2-3 per script, vary across scripts)

**2A**: "And that wasn't even the part that got people angry."
**2B**: "But [SUBJECT] wasn't done yet. Not even close."
**2C**: "This is where the story takes a turn nobody expected."
**2D**: "What comes next is the part that still doesn't make sense."
**2E**: "If that sounds bad, keep watching."
**2F**: "And then [SUBJECT] made the one decision that changed everything."
**2G**: "But here's the detail that everyone missed at the time."
**2H**: "That was only round one."

### Rotation Bank: Curiosity Rehooks (Pick 2-3 per script)

**2I**: "There's a reason this story is still talked about today."
**2J**: "Now, [SUBJECT] could have stopped there. They didn't."
**2K**: "The real question is what happened behind closed doors."
**2L**: "But the version you've heard? That's not the full picture."
**2M**: "And the timing of what happened next? Almost too perfect."
**2N**: "Most people never heard about this part."
**2O**: "Pay attention to this next detail, because it explains everything."
**2P**: "And this is the part where things stopped being funny."

---

## SLOT 3: POST-MID-CTA RETURN

After the subscribe CTA at ~55-65% of the video, Claude defaults to: *"Now, let's talk about..."* or *"Now let's get into..."* or *"Okay, moving on..."*

### Rotation Bank (Pick ONE per script)

**3A: The Continuation**
Don't acknowledge the CTA at all. Continue the story as if it never happened.
```
[Pick up exactly where the narrative left off, mid-beat.]
```

**3B: The Escalation Drop**
Return with something heavier than what came before.
```
So, [recap one line of where we were]. But what [SUBJECT] did next made all of that look tame.
```

**3C: The Time Jump**
Use a time marker to re-anchor the viewer.
```
By [MONTH/YEAR], [new status or development that moves story forward].
```

**3D: The New Character**
Introduce a new player or element.
```
Enter [NEW PERSON/ELEMENT]. [One sentence about why they matter.]
```

**3E: The Zoomed-Out Reframe**
Pull back to a wider view before diving back in.
```
While all of this was happening, [larger context the viewer wasn't thinking about].
```

**3F: The "Meanwhile" Cut**
Shift to a parallel thread that was developing alongside the main story.
```
While [SUBJECT] was dealing with [previous section's events], something else was brewing.
```

**3G: The Direct Pull-In**
Address the viewer directly to re-engage after the CTA.
```
Alright, so here's where things get [specific adjective: messy / interesting / dark / complicated].
```

---

## SLOT 4: SECTION TRANSITIONS (Between Major Story Beats)

Defaults: *"But things were about to get much worse," "However, things were about to change," "And that's when everything fell apart."*

### Rotation Bank (Pick ONE per transition, vary across sections)

**4A: The Ticking Clock**
```
[SUBJECT] had [timeframe] before [consequence]. And the clock had already started.
```

**4B: The Quiet Before the Storm**
```
For a while, things actually seemed fine. [Brief calm detail.] That didn't last.
```

**4C: The Outsider's Warning**
```
[Someone specific] saw it coming. [What they said/did.] Nobody listened.
```

**4D: The Ironic Detail**
```
The same [thing/person/decision] that built [SUBJECT]'s [success] was about to destroy it.
```

**4E: The Hard Cut**
No transition line. End the section on a strong beat and start the next section with a new time/place anchor.
```
[End section with a punchy final line.]

[NEW DATE/LOCATION.]
[First sentence of new section.]
```

**4F: The Reversal**
```
Everything [SUBJECT] had built was about to work against them.
```

**4G: The Foreshadow Plant**
```
[Specific small detail from this section] would come back to haunt [SUBJECT]. But that's getting ahead of the story.
```

**4H: The Momentum Shift**
```
Up to this point, [SUBJECT] had been [winning/in control/on top]. That was about to flip.
```

**4I: The Scope Expansion**
```
But this wasn't just about [SUBJECT] anymore. [Wider stakes or new parties involved.]
```

---

## SLOT 5: CONTROVERSY / EVIDENCE STACKING

Used in exposés and scandal docs when layering multiple pieces of evidence. Default: *"But the allegations didn't stop there," "And that wasn't even the worst part."*

### Rotation Bank (Pick ONE per layer)

**5A**: "That was just the story the public knew. Behind the scenes, [new angle]."
**5B**: "And if that were the only problem, [SUBJECT] might have survived it. But then [next revelation]."
**5C**: "[TIME PERIOD] later, a second [accusation/leak/report] surfaced."
**5D**: "People thought they had the full picture. They were wrong."
**5E**: "Then [SPECIFIC PERSON] came forward with [what they revealed]."
**5F**: "The [document/recording/email] that leaked next made everything worse."
**5G**: "Just when [SUBJECT]'s team thought they'd contained the damage, [next event]."
**5H**: "And this next part is the one that even [SUBJECT]'s supporters couldn't defend."

---

## SLOT 6: COMMENTARY / REACTION LINES

These add "personality" to faceless narration. Defaults that get overused: *"Yeah, you read that right," "Let that sink in," "Absolute shocker, right?"*

### Rotation Bank (Pick 2-4 per script, never the same combo twice in a row)

**6A**: "I mean, think about that for a second."
**6B**: "That's not a typo, by the way."
**6C**: "[Specific rephrasing of the shocking detail in simpler terms]."
**6D**: "And somehow, it gets worse."
**6E**: "If you're wondering how that's even legal, so is everyone else."
**6F**: "[Dry understatement]. So yeah, not great."
**6G**: "Read that again." *(use max once per 5 scripts)*
**6H**: "That's the kind of number that makes accountants cry."
**6I**: "You'd think someone would have said something. Nobody did."
**6J**: "Which, looking back, was either incredibly brave or incredibly stupid."
**6K**: "And no, I'm not making that up."
**6L**: "[Short sardonic observation specific to the topic]."

---

## SLOT 7: FORESHADOWING LINES

Used to tease what's coming next. Default: *"But [SUBJECT] had no idea what was coming," "Little did they know..."*

### Rotation Bank (Pick ONE per use)

**7A**: "[SUBJECT] would look back on this moment and wish they'd made a different call."
**7B**: "This decision seemed small at the time. It wasn't."
**7C**: "In [TIMEFRAME], [SUBJECT] would understand exactly what this meant."
**7D**: "[Specific detail] was a warning sign. [SUBJECT] ignored it."
**7E**: "If [SUBJECT] had stopped here, this would be a very different story."
**7F**: "Everything was in place. [SUBJECT] just didn't know what 'everything' was building toward."
**7G**: "The clock was already ticking. [SUBJECT] just couldn't hear it yet."
**7H**: "[SUBJECT] celebrated. They shouldn't have."

---

## SLOT 8: OUTRO / REFLECTION CLOSERS

The final reflective beat before CTA. Default: *"[SUBJECT]'s story shows us that...," "Whether you love them or hate them..."*

### Rotation Bank (Pick ONE per script)

**8A: The Full Circle**
Return to an image or detail from the opening and reframe it.
```
[Reference to opening detail], except now [how meaning has shifted].
```

**8B: The Unanswered Question**
Leave the viewer with something to chew on.
```
The real question isn't [obvious question]. It's [deeper question].
```

**8C: The Quiet Landing**
End on a factual, understated note. Let the weight of the story do the work.
```
[Simple factual statement about where things stand today. No editorializing.]
```

**8D: The Wider Lens**
Pull out to show what this story means beyond the subject.
```
[SUBJECT]'s story isn't unique. [How this pattern repeats / what it reveals about the system].
```

**8E: The Ironic Echo**
Echo a quote, promise, or claim from earlier in the script that now reads differently.
```
[Quote or claim from earlier]. [How reality contradicts it.]
```

**8F: The "Still Going" Close**
For stories that aren't over.
```
As of [DATE], [current status]. This story isn't over. Not even close.
```

**8G: The Human Moment**
End on something personal or humanizing about the subject.
```
[Small, specific, human detail about the subject that reframes the entire story.]
```

**8H: The Legacy Frame**
Frame the ending around what endures.
```
[What survived / what people remember / what changed permanently because of this story.]
```

---

## SLOT 9: HOOK TURN MECHANICS

The "turn" in the hook where you flip from setup to tension. Default: always using "However," or "But" in the same structural position.

### Rotation Bank (Pick ONE per script)

**9A: The Classic "But"**
Standard contrast. Use sparingly since it's the most common.
```
But [contrasting reality].
```

**9B: The Question Turn**
Replace the declarative turn with a question.
```
So why did [contradiction to setup]?
```

**9C: The "Then" Disruption**
A sudden event breaks the setup.
```
Then, on [DATE], [disruptive event].
```

**9D: The "What nobody knew" Turn**
Frame the turn as hidden information.
```
What nobody knew at the time was that [hidden reality].
```

**9E: The Double Take**
State something positive, then immediately undercut it.
```
[Positive statement.] At least, that's what everyone thought.
```

**9F: The Reversal Question**
Flip the narrative and ask why the opposite happened.
```
[Setup of success.] So how did [SUBJECT] end up [opposite state]?
```

**9G: The Timestamp Turn**
Use a specific date/timeframe as the pivot.
```
[Setup.] That was [MONTH, YEAR]. By [LATER DATE], [opposite reality].
```

**9H: The Third-Party Turn**
Introduce the disruption through someone else.
```
[Setup.] And then [THIRD PARTY] [action that changed everything].
```

---

## ROTATION LOG TEMPLATE

**Claude MUST append this to every script output, AFTER the Re-Audit confirmation:**

```
🔄 **Rotation Log**
- Slot 1 (Context Bridge): [NUMBER, e.g., 1C]
- Slot 2 (Rehooks used): [NUMBERS, e.g., 2B, 2L, 2P]
- Slot 3 (Post-Mid-CTA): [NUMBER, e.g., 3F]
- Slot 4 (Section Transitions): [NUMBERS, e.g., 4B, 4G, 4E]
- Slot 5 (Evidence Stacking): [NUMBERS if applicable, e.g., 5B, 5F]
- Slot 6 (Commentary Lines): [NUMBERS, e.g., 6A, 6F, 6K]
- Slot 7 (Foreshadowing): [NUMBERS, e.g., 7D, 7H]
- Slot 8 (Outro Closer): [NUMBER, e.g., 8E]
- Slot 9 (Hook Turn): [NUMBER, e.g., 9F]
```

**User instruction:** Copy the Rotation Log from your last script and paste it into the next script prompt with the note: *"Avoid these rotation numbers from last script: [paste log]"*

**VidRush users:** Remove the Rotation Log from the script before pasting into VidRush's custom script field. The emoji and markdown formatting will be read aloud by TTS.

---

## CROSS-SCRIPT RULES

1. **Never use the same Slot 1 + Slot 9 combo** two scripts in a row (these define how the opening *feels*)
2. **Rehooks (Slot 2):** Use at least 3 different numbers per script, and swap at least 2 out between consecutive scripts
3. **Commentary lines (Slot 6):** Rotate at least 3 of 4 selections between scripts
4. **Section transitions (Slot 4):** Use at least 2 different numbers within each script, and avoid repeating your most-used from last script
5. **If you catch yourself gravitating toward the same numbers** across 3+ scripts, force yourself into the options you've been avoiding

---

## EMERGENCY VARIETY CHECK

If a script STILL feels repetitive after rotation, check for these sneaky defaults that aren't covered by slots:

- **"The truth is..."** → Cut it. Just state the truth.
- **"In fact..."** → Usually unnecessary. Delete and the sentence works fine.
- **"You see..."** → Filler. Remove.
- **"Here's the thing..."** → Overused. Replace with the actual thing.
- **"At the end of the day..."** → Cliché. Use a specific instead.
- **"Fast forward to [YEAR]..."** → Vary with: "By [YEAR]," / "[YEAR] changed everything." / "[NUMBER] years later," / Start with the event, mention the year mid-sentence.
- **"It didn't take long for..."** → Replace with a specific timeframe.
- **"Long story short..."** → Don't summarize. Tell the story.
- **"Needless to say..."** → If it's needless, don't say it. If it matters, just say it.
- **"As it turns out..."** → Vary with: "What [PERSON] discovered was..." / "The [investigation/audit/report] revealed..." / Just state the finding.

---

**FacelessOS v5** → Every script should feel like its own thing.
