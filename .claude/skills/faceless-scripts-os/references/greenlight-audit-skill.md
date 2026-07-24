---
name: greenlight-audit
description: The self-audit every script runs before it is called final. Five groups with concrete pass conditions (Hook, Retention, Red-Tape, Voice + Anti-slop, Authenticity), a fenced verdict block, and the loop that re-runs until a fully clean pass. Absorbs the v4 authenticity audit as Group E. Run as the last step of the workflow, on every script, every time.
---

# Greenlight Audit

A finished draft is not a finished script. Before any script leaves the system, it runs this audit: five groups, A through E, each a set of concrete checks with a pass condition. Findings first, verdict last. The audit is the last step of the workflow, after the draft exists and after the write-time discipline in `voice-anchoring-skill.md` already happened.

Four rules govern every run:

→ **Run all five groups on every script.** No partial passes. A group you skipped is a group that failed.
→ **Collect every finding before rendering the verdict.** A HOLD in one group changes whether fixing the others matters, so grade the whole script first, decide second.
→ **A finding needs evidence.** Name what you checked against and quote what you found. "Checked, fine" is a rubber stamp; Group D makes the evidence rule explicit, and it binds A, B, and C in artifacts, not in spirit. On a clean result, A, B, and C each carry a cheap artifact in the verdict block, mandatory even when the group passes:
  → **A line:** quote sentence one verbatim, state the hook word count, and name the turn (But / However / equivalent).
  → **A5/C5 line:** name the promise the hook makes, and map each promised item to the exact body section that pays it off.
  → **B line:** the loop ledger, every opened loop and the line where it closes.
  A group that reports "clean" without its artifact is a rubber stamp and sends the audit back to that group, same logic as D4.
→ **A finding is held to the same evidence bar as a clean pass.** To fail any check, quote the exact offending text from the script AND name the pass-condition it violates. If you cannot quote a line that fails the stated condition, there is no finding, mark the check clean. A hook whose first sentence already contains the reversal or jolt passes A2 even if a later sentence is weaker; do not manufacture a failure the text does not support. This kills false positives without softening a single real catch: a genuinely bad hook still has quotable failing text, so the bar that stops the invented finding never blocks the true one.
→ **Never trust the first "clean."** After fixes, re-run the sweep and confirm the before and after counts. A pass is a fresh full run with zero findings, never a self-report from the run that did the fixing.

Run the groups in order, A through E: structure first (A, B, C), register second (D), policy last (E). The order matters because a HOLD-grade structural problem makes line-level polish irrelevant; find it before you spend a pass polishing sentences that will not survive the re-outline. And the audit is not a one-time event: any revision after a PASS sends the script back through the full audit, because edits reintroduce tells.

The audit produces the verdict block defined at the end of this file. The block stays attached while the script loops through fixes and gets stripped before the script ships as final output.

---

## Group A - Hook

- [ ] **A1. First-50 discipline.** Pattern interrupt + specific proof + open loop, all landing inside the first ~50 seconds. The hook runs under 100 words and contains a "But" or "However" turn, or an equivalent turn (a reversal the words "but" or "however" would introduce, however it is actually phrased). Names and numbers are specific, never vague, and every number is real and sourced.
  **Pass:** all three elements present, under 100 words, turn present, zero unsourced numbers.

- [ ] **A2. Scroll-stop.** Sentence one is a jolt, not homework and not a greeting. No wind-up, no "in this video," no backstory before the tension.
  **Pass:** the first sentence, read alone, gives a viewer a reason to stay.

- [ ] **A3. Four-part shape.** The hook runs the four-part build: Context Lean (the one line of grounding the jolt needs), Scroll-Stop Interjection (the jolt itself), Contrarian Snapback (the turn against what the viewer expected), Promise (what the video will show). The parts can compress or overlap in a short hook; what fails is a hook missing the turn or the promise entirely.
  **Pass:** all four parts identifiable, in shapes a narrator can actually say (Group D applies to the hook hardest of all).

- [ ] **A4. The bar, not the batch.** The hook clears your niche's proven winners on its own merits, not just "differs from your last upload." Grade against 2-3 top-performing hooks in your lane, and those hooks come from a real source, never memory. Pull them verbatim from one of: the user, the session's research step, or the shipped swipe files (`REAL-FACELESS-HOOK-SWIPE.md`, `NICHE-SPECIFIC-HOOKS.md`). Quote the ones you graded against in the A4 result. A remembered "winner" is the exact failure `voice-anchoring-skill.md` forbids for anchors: the model invents a plausible hook and grades against fiction. If none of the three sources gives you a real comparison hook, A4 is BLOCKED: could not run this check, no comparison source in the session. Record it as BLOCKED on the A verdict line, and stop there. BLOCKED is a not-run, not a defect: it is NOT counted among the numbered fixes and it is NOT a reason to withhold PASS on the other groups. A4 becomes an actual finding only when a comparison source WAS available and the hook lost against it, quoted per the evidence bar. In a real session the research step or the swipe files supply the comparison, so a BLOCKED A4 usually means that step has not run yet, never that the hook failed.
  → Is the video's best tension planted in the hook, instead of saved for the climax?
  → Does the proof or artifact land before any setup or backstory?
  → Would this stop the scroll sitting next to those winners?
  **Pass:** yes to all three, graded against quoted real hooks. A hook that fails any of them gets rewritten around the video's strongest move, then re-graded.

- [ ] **A5. Promise made, specific, and mapped.** One clear promise. It matches the title, no bait-and-switch. Every item the hook promises ("three signs," "the full timeline") maps 1:1 to a real section in the body. After any hook rewrite, check for a leftover second enumeration, and check that Section 1 bridges from the hook instead of restating it verbatim.
  **Pass:** promise = title = body structure, verified against the actual body, not the outline.

- [ ] **A6. Hook claims hold up.** Any stat or claim in the hook is consistent with what the body actually shows. A hook that says "lost everything" over a body that shows "down for one quarter" is an over-promise and fails.
  **Pass:** no hook claim exceeds its body evidence.

## Group B - Retention

The terms below are defined in `retention-mechanics-skill.md`. Use its definitions, never a paraphrase from memory.

- [ ] **B1. Dopamine Ladder ascent.** The script climbs the ladder: the hook triggers Captivation (an open question pops in the viewer's mind), each section builds Anticipation before its answer, Validation closes each loop completely with a non-obvious payoff, and the close points at a concrete next thing.
  **Pass:** every opened loop closes, and no loop closes without the next one opening (until the final payoff).

- [ ] **B2. But/Therefore chaining.** Beats connect causally. Test every join between beats: does it read as "but" or "therefore"? A join that only reads as "and then" is flat.

  **Fails because:**
  ```
  "The channel posted daily, and then it tried a new niche, and then the views went up."
  ```
  Three events, zero causality. Add the obstacle, the turn, or the consequence until each join reads as "but" or "therefore."
  **Pass:** zero "and then" joins across the script.

- [ ] **B3. Rehook cadence.** A transition or rehook lands at least every 60-90 seconds, and the pacing benchmarks in `retention-mechanics-skill.md` set the tighter target: rehook every 30-45 seconds, mini-payoff every 60-90 seconds, new information every 15-30 seconds. Within 10 seconds of every payoff, the next curiosity gap is already open. Convert seconds to words at ~145-150 spoken words per minute (the same rate the workflow's length calibration uses), so 90 seconds is about 220 words; measure the flat stretch in words, not a stopwatch you do not have.
  **Pass:** no flat stretch longer than 90 seconds (~220 words), no payoff followed by silence.

- [ ] **B4. None of the 4 Deadly Retention Mistakes.**
  → **The Delay Disease:** the first 10 seconds state what the video is about, using "you" or "your." A slow, throat-clearing open fails.
  → **The Context Dump:** the Golden Ratio holds: ~30 seconds of context for every ~60 seconds of action and examples. Show it working before explaining why it works. The post-hook bridge is where this one lives: the first sentence after the hook pays or escalates, never orients. An opener like "To understand why..." or "First, let's go back..." with no payoff beat before it is a finding; quote it.
  → **The Payoff Void:** after each payoff, the next loop opens within 10 seconds. The "I got what I came for" exit window never stays open.
  → **The Grand Payoff Betrayal:** the main payoff is foreshadowed three times (hook, then twice more spaced across the body, scaled to runtime, around minute 3 and minute 8 on a ten-minute video, proportionally earlier on a short one) and delivered as the culmination of everything before it, never swapped for something smaller.
  **Pass:** zero of the four present anywhere in the script.

- [ ] **B5. Progression.** Every paragraph delivers at least one of the 4 Elements of Progression: new information, progression toward the goal, regression or obstacles, or emotional change.
  **Pass:** no paragraph delivers none of the four.

- [ ] **B6. Sentence rhythm.** Lengths vary, per the Gary Provost principle in `retention-mechanics-skill.md`: judge the drone, not the count. A run of same-length sentences that reads monotone fails; a deliberate enumeration ("Rent. Insurance. Payroll.") does not, because D1, the scanner doctrine, and humanizer H5 all protect it as speech. Put each sentence on its own line; outside enumerations, the right edge should look jagged, not straight.
  **Pass:** no monotone drone, and the rhythm survives a read-aloud.

- [ ] **B7. Point ordering (list videos).** Second-best point opens, best point sits in the middle, third-best closes. One exception: a ranked countdown legitimately saves #1 for last, because the reveal itself is the open loop.
  **Pass:** ordering matches, or the countdown exception genuinely applies.

- [ ] **B8. No dead sections.** Every section earns its place on the ladder and the promise map.
  **Pass:** cutting any section would visibly break the A5 promise map or drop a loop.

- [ ] **B9. Retention killers.** Sweep the spoken copy for the four killers named in `retention-mechanics-skill.md`:
  → **Repetition disguised as emphasis:** the same point restated with the wording shuffled.
  → **Unnecessary qualifiers:** "I think this might potentially" stacks that drain every claim they touch.
  → **Obvious statements:** announcing the next point instead of making it.
  → **Throat-clearing:** "so, um, basically" wind-ups before the actual sentence.
  Also check the close: a script that signals the ending before the last payoff ("so that wraps up," a summary wind-down), continues past the final payoff, or parks a CTA after it is a finding. The script ends AT the final payoff with the next-video handoff woven in; CTAs live mid-content per `outro-psychology-skill.md`.
  **Pass:** zero of the four in spoken copy, and the close ends at the final payoff with no ending signal before it.

## Group C - Red-Tape

- [ ] **C1. Connecting thread.** Grab any sentence at random and trace it back to the spine, the one idea the video exists to pay off. "Also..." and "Another thing..." orphan ideas fail.

  **Fails because:**
  ```
  "Also, fun fact, the founder once spent a whole summer living in his car."
  ```
  If the spine is how the product beat its market, the car summer is an orphan. Tie it to the spine or cut it; an interesting line that connects to nothing still fails.
  **Pass:** every sampled sentence traces to the spine. Zero orphans.

- [ ] **C2. Easy to follow.** A 12-year-old follows the whole argument on one listen. Read the script aloud, top to bottom: no stumbles, no sentence that needs a second pass, no hand-off between sections that loses a cold listener. Hard material is fine; it gets deduced down until anyone can follow it, and it never gets waved through as "actually easy."
  **Pass:** one clean read-aloud, start to finish, no stumble and no re-read.

- [ ] **C3. Identification.** The script names the viewer's exact situation in the viewer's own words, the vocabulary your comments and your niche actually use, not problems you assume they have.
  **Pass:** at least one moment where the target viewer would think "that is exactly my situation," phrased in their language.

- [ ] **C4. Perspective shift.** The script states the conventional wisdom, challenges it, lands a new frame, then proves the frame. The viewer's belief at the end differs from their belief at the start.
  **Pass:** all four beats present and in that order.

- [ ] **C5. Payoff delivered as promised.** The structure the hook promised plays out exactly: promised "five signs" means five signs as sections, numbered honestly, none skipped or doubled. The grand payoff lands through the final insight itself and pushes understanding past the obvious. The close goes straight to substance; it never announces the payoff or calls back to the promise ("that's what I promised you at the start" and its entire family fail on sight, because a payoff you have to point at did not land).
  **Pass:** promise kept 1:1, payoff delivered rather than narrated, close is substance.

## Group D - Voice + Anti-slop

This group leans on the two sibling files and the scanner. Open them and run from the open file; never run this group from memory of what they say.

Run order inside the group: D3 machine pass first, then D1 sentence by sentence, then D2 in clusters, then the D7 counts, then assemble the D4 evidence.

- [ ] **D1. The shape test, per `voice-anchoring-skill.md`.** Every sentence of spoken copy gets the question: "Does the narration in your anchor sample ever build a sentence like this?" Judge the shape, not the quality; reading well is exactly how bad lines survive. Hunt the four written-not-spoken tells by name: **Movie Trailer**, **Wise Narrator**, **Staccato-Robotic**, **Reading-Not-Speaking**. Enumerations, live-demo narration, and self-corrections are real speech, leave them alone. The fix is register translation, never de-clawing: the jolt, the proof, and the planted tension all survive, only the delivery changes. If the fix made the line weaker, the fix is wrong; translate again.
  **Pass:** every spoken sentence matches a shape that appears in the anchor sample.

- [ ] **D2. The H1-H17 sweep, per `humanizer-skill.md`.** Run the full catalog, H1 through H17, against the spoken copy, including the mechanical sweep from that file's run procedure: curly and smart quotes, the ellipsis character, non-ASCII, emoji, chatbot artifacts ("I hope this helps", "Would you like"), and knowledge-cutoff disclaimers ("as of my last update"). This is the last gate before ship and no other group owns those artifacts; a leftover chatbot line here is the worst miss in the file. Judge by clusters, never isolated hits: one "-ing" opener is noise, three in a row plus an aphorism closer is a signature. Don't gut the human parts; a sweep that leaves the copy flat has failed even with every pattern gone. Finish with the closing loop from that file: ask "what still reads AI?", fix what you named, ask again, and only stop when the honest answer is nothing.
  **Pass:** no cluster stands, zero mechanical artifacts, and the copy still sounds like a person.

- [ ] **D3. The machine-ban check.** Run the scanner over the draft: `python3 trailer-voice-scan.py your-script.md`. The scanner lives one level above this skills folder, at the system root. Fix every HARD-BAN hit on sight, no adjudication, no "but it fits here." Judge its remaining flags (staccato runs, narrator prophecy, clever written pairs) with the D1 shape test. Note the scanner reads plain paragraphs and skips bullets, headers, and bold-prefixed lines, so format the voiceover copy as plain paragraphs before scanning or it will scan nothing.
  If the environment cannot execute Python (a Claude Project cannot), the check does not get waived: open the machine list in `humanizer-skill.md` (Two-tier bans, machine tier) and sweep the draft against it by hand, phrase by phrase, every phrase on the list, then hunt the scanner's shape flags by eye. The by-hand pass is the same pass; "I would have caught it if I could run the script" is not a result.
  **Pass:** zero machine-tier phrases in spoken copy, every shape flag adjudicated by quoted rule, and zero emdashes anywhere in spoken copy (H15 rides on this check).

- [ ] **D4. Quoted evidence, mandatory.** A Group D result must QUOTE which anchor shapes it validated the script's voice against: name the anchor (whose transcript, which upload), quote two or three sentence shapes from it verbatim, and set at least one script line next to the anchor shape it matches. This holds even when the finding is "clean." A D entry that reads "checked, fine" with no quotes is a rubber stamp and does not count as a pass: re-run the group and bring the quotes.
  **Pass:** the verdict block's D line carries the anchor name, the quoted shapes, and a matched script line.

- [ ] **D5. Numbers honest.** Every number in the script is specific, real, and sourced. No invented stats, no suspiciously specific fake numbers (a "47%" or a "37 days" that appears in no source is a known generated-copy tell), no dressing a real number up as something rounder and more dramatic. Like D4, this gate carries an artifact, mandatory even when clean: the verdict block's D5 sub-line lists every number and statistic in the script with its named source. A number with no nameable source is a finding by definition, so a bare "numbers clean" with no ledger is a rubber stamp and sends the audit back to D5. The source has to be a specific, on-screen-citable artifact (a named report with its publisher and year, a named study, a screenshot in the research notes, the primary page the figure lives on), never a category that names nothing: "industry reports," "a study," "studies show," "recent data" is the H14 weasel-attribution dodge, and in the ledger it counts as no source at all. If the ledger entry would not survive being put on screen as the citation, the number fails D5.
  The fix depends on which kind of number it is:
  → An unverifiable-but-plausible number the video does not lean on gets cut or reworked as a numbered fix (FIX-THEN-PASS).
  → An invented fact the video LEANS ON, or a number that still fails after you claim to have checked its source, is a HOLD: editing cannot make an invented fact true.
  **Pass:** every number traces to a named source you could put on screen, and the D5 ledger on the verdict block proves it.

- [ ] **D6. The master anti-slop checklist.** Run the ANTI-AI SLOP CHECKLIST (Patterns 1-8) in `faceless-scripts-os-master.md` against the spoken copy, from the open file, not from memory. H1-H17 and the scanner do not cover all eight: the "Most people..." / "Most founders..." opener (Pattern 3), the max-one "it's not X, it's Y" reframe (Pattern 4), and the empty-emphasis words (Pattern 6: powerful, transformational, revolutionary, game-changing) each live only on the master list, so a sweep that skips it lets them ship. Judge by the same cluster logic as D2, and honor the master's own carve-outs (one contrast per script, colons on the phrase not the punctuation).
  **Pass:** zero uncovered master-list patterns stand in spoken copy.

- [ ] **D7. Antithesis and aphorism density, counted.** A by-eye judgment count, same territory as the D2 cluster calls, not a machine claim: the scanner only catches one narrow shape of this (its "clever written pair" flag), so a clean D3 does not clear it. These two shapes read well line by line, which is exactly how they slip past every other check and stack up until the whole script has the same polished cadence. Count both across the full spoken copy and put the counts on the verdict block even when the result is clean:
  → **Antithesis constructions.** The whole family, not just the literal phrase: "it's not X, it's Y," "it wasn't A, it was B," "survived nine years of one thing and lasted six weeks in another," and any mirrored-clause contrast built for balance. The literal "it's not X, it's Y" reframe stays capped at one per script by Pattern 4 in `faceless-scripts-os-master.md` (D6 enforces that); D7 counts the full family that Pattern 4's wording does not reach.
  → **Aphoristic closers.** Paragraphs that end on a balanced, quotable verdict sentence, the poster-ready shape `humanizer-skill.md` names as H10 aphorism formulas.
  **Threshold:** at most 2 antithesis constructions per script, at most 1 aphoristic closer, and never either shape in two adjacent paragraphs. Over the threshold is a finding: keep the strongest single instance and rewrite the excess into plain statements. The substance survives every rewrite, the claim, the numbers, the actual contrast between the two facts; only the balanced delivery goes. This is H10's own carve-out made countable: one earned aphorism at the climax can stay, a pattern of them cannot, and the same license covers one sharp antithesis.
  Why this gate exists, in one line: a single sharp antithesis or one earned aphorism is craft, but the same shape closing every paragraph is the tell, because real speech has flat sentences and clunkers between the sharp ones.
  **Pass:** both counts at or under threshold, no adjacent-paragraph repeats, and the D7 line on the verdict block carries the counts, clean or not.

## Group E - Authenticity

Folded from the v4 authenticity audit. This group checks YouTube POLICY safety, not writing quality: whether the platform's automated systems will read the video as inauthentic or reused. Two threats drive it:

→ **"Inauthentic content"** is channel-level: mass-produced, template-driven videos with minimal creative input. It gets videos demonetized, monetization applications denied, and channels terminated.
→ **"Reused content"** is monetization-level: the video does not add enough original value on top of what already exists. It blocks AdSense approval and can strip monetization from a running channel.

Faceless channels get hit by both more than any other format. A script indistinguishable from a thousand other generated videos will be treated as one.

- [ ] **E1. Uniqueness signals: score out of 7, pass at 5 or more.**
  → **Original research:** facts, quotes, or data NOT found on page 1 of Google for this topic.
  → **Unique angle:** a perspective different from the top 5 existing videos on the topic.
  → **Editorial voice:** the narration opines, judges, and reacts, instead of only reporting facts.
  → **Specific sourcing:** at least 3 named sources referenced or woven into the narrative, never vague "studies show."
  → **Non-obvious connections:** the script links facts or events in a way that is not immediately obvious.
  → **Original structure:** not the same chronological or listicle skeleton as the most popular video on the topic (`variety-rotation-skill.md` keeps this from recurring across your own uploads too).
  → **Human review evidence:** you personally reviewed and edited the script; it is not raw model output.

  **Score only from evidence in front of you.** A signal scores its point only from evidence present in the session, the research notes, the reference pull, the sources actually woven into the draft. The page-1 and top-5 signals ("not found on page 1 of Google," "different from the top 5 existing videos") score from the research-and-ideation brief's logged searches: the PROOF BANK, the outlier pull, and the top-5 comparison ARE the live search this step needs, so a signal backed by that documented session evidence scores its point. A signal scores 0 only when NO research-step evidence for it is present in the session, the same "claimed vs. true" logic as the Raising a low E1 score list below. Human review evidence is the one exception: it scores 0 at audit time by default, because the script was just generated and no buyer has touched it, and it scores its point only when the buyer confirms an edit pass mid-loop. Never award a point for a signal you cannot see the evidence for.
  **Pass:** 5 of 7 or better, counting only evidenced signals. The score, which signals passed, and which scored 0 for missing evidence, goes on the verdict block's E line.

- [ ] **E2. Red flags: must be ZERO.**
  → **Template scripting:** the script reads like fill-in-the-blank where only the topic name changes.
  → **Duplicate publishing:** this script, or a near-identical version, going out on multiple channels.
  → **Bulk pattern:** 5+ similar videos per day across channels.
  → **Verbatim copying:** sentences lifted word-for-word from an existing video's transcript.
  **Pass:** 0 of 4. One red flag fails the group regardless of the E1 score.

- [ ] **E3. Reference-clone check.** Modeling a proven reference video is how this system works, so this check exists to keep the model from drifting into a clone. If the title or structure closely mirrors the reference, confirm the ANGLE, the editorial voice, and the sourcing make this an original video rather than a swap. A script that mirrors its reference on all three is reused content in policy terms, whatever the writing quality.
  **Pass:** the angle and the voice diverge from the reference, with sourcing of your own on top.

- [ ] **E4. AI-video checks (only when an AI tool generates the video).** The reference video is human-narrated, not AI-voiced (AI mimicking AI is the most flaggable combination). The stock-footage sequence is not identical to other videos on the topic. At least one custom element is in: your own voiceover, a custom thumbnail, an edited timeline, or added overlays.
  **Pass:** all three, or the whole check is N/A and marked N/A on the E line.

**Raising a low E1 score (the fastest signal fixes):**
→ Add editorial commentary: react to the facts instead of only reporting them. The reaction is the part a viewer cannot get from a summary.
→ Add original analysis: connect two facts nobody else covering the topic is connecting.
→ Research past page 1: if every fact comes from the first result, the script will sound like every other script on the topic.
→ Vary the structure against the topic's most popular video, and against your own recent uploads.
→ Edit the script yourself: 15-30 minutes of your own edits moves the human-review signal from claimed to true.

**Channel-level watch signals (not per-script checks, monitor them):**
→ Monetization application denied for "reused content" → audit all recent scripts against E1-E3, then appeal with evidence of original work.
→ Comments saying "this sounds AI" or "heard this before" → re-check recent scripts for template patterns, add editorial voice.
→ Suspiciously uniform view counts across videos → distribution may be suppressed, vary structure and topics.
→ An "inauthentic content" warning in YouTube Studio → stop publishing, audit the whole channel, remove flagged videos.
→ A sudden impressions drop across all videos → check for policy notifications before assuming the algorithm moved.

The safety ladder, from most flaggable to safest: raw generated script + generated video + no edits + bulk publishing sits at the dangerous end; a custom script over a modeled reference is better; an edited timeline with custom elements better still; your own voiceover + original research + editorial voice is the safe end. Every step toward the safe end is a step this group can verify.

## Verdict block

Every audited script ends with this fenced block, filled in. One line per group: the finding, or "clean." Five lines carry a mandatory artifact even when clean, and a clean line missing its artifact sends the audit back to that group: the A line quotes sentence one, the B line lists the loop ledger, the D line carries the quoted anchor evidence, D5 lists every number with its source, and D7 carries its two counts. Number the fixes consecutively across all groups (1, 2, 3...) so the block reads as one work order.

```
VERDICT: PASS | FIX-THEN-PASS | HOLD
- A Hook:         clean, or the finding + numbered fix. Always: sentence one = "...", hook words = N, turn = [But / However / equivalent]
- B Retention:    clean, or the finding + numbered fix. Always: loop ledger = [loop 1 opens L__ closes L__; loop 2 opens L__ closes L__; ...]
- C Red-Tape:     clean, or the finding + numbered fix
- Promise map:    [hook promises X, Y, Z] -> [X = Section _, Y = Section _, Z = Section _] (A5/C5)
- D Voice:        clean, or the finding + numbered fix. Always: anchor = [whose transcript, which upload], shapes quoted = "..." / "...", matched line = "..."
- D5 Numbers:     [number 1 = source; number 2 = source; ...] or "no numbers in script"
- D7 Antithesis:  [N antithesis constructions, M aphoristic closers; threshold ok, or the finding + numbered fix]
- E Authenticity: [X/7 signals, N red flags] clean, or the finding + numbered fix
- Files used:      [skill files consulted this script, by filename]
```

The Files used line lists which skill files were actually opened and applied across the whole script's production, from research through this audit, not just the files this audit consulted. A skipped part of the system shows up on the block instead of staying invisible.

A filled example, mid-loop:

```
VERDICT: FIX-THEN-PASS
- A Hook:         clean. Sentence one = "This channel made $40,000 in a month with zero subscribers."; hook words = 82; turn = But
- B Retention:    1. Section 3 payoff closes with no new loop for ~40s (Payoff Void). Open the Section 4 question inside 10s of the payoff. Loop ledger = [subscriber-count loop opens L1 closes L58; how-they-did-it loop opens L12 closes L94; the-catch loop opens L60 closes L140]
- C Red-Tape:     clean
- Promise map:    [hook promises the $40k proof, the three-step method, the catch] -> [$40k = Section 1, method = Sections 2-4, catch = Section 5]
- D Voice:        2. One Wise Narrator verdict sentence in Section 2, translate per D1. Anchor = my last 3 upload transcripts; shapes quoted = "Rent. Insurance. Payroll. That's where the money went." / "It took ten years. Twelve, actually."; matched line = the Section 1 cost rundown.
- D5 Numbers:     [$40,000 = the channel's YouTube Studio revenue screenshot published in its own community post, in the research notes; 30 days = the upload timeline in the same notes; 0 subscribers = the channel page at record time]
- D7 Antithesis:  [2 antithesis constructions, 1 aphoristic closer; threshold ok, none adjacent. The closer is the Section 5 climax line, kept per the H10 carve-out]
- E Authenticity: [5/7 signals, 0 red flags] clean (missing: original structure; human review scored 0 pending buyer edit pass. Page-1 and top-5 signals scored from the session research pull, the PROOF BANK and top-5 comparison, not a memory guess)
- Files used:      research-and-ideation-skill.md, faceless-scripts-os-master.md, script-structures-skill.md, retention-mechanics-skill.md, voice-anchoring-skill.md, humanizer-skill.md, trailer-voice-scan.py
```

**The three verdicts:**

→ **PASS.** Every group clean on a single fresh run, with the D line quoted. A run that applied fixes cannot award its own pass; the pass comes from the next full run.
→ **FIX-THEN-PASS.** Local, listable problems. Number the fixes in the block, apply them, then re-run the ENTIRE audit, all five groups, on the fixed script. Loop until a run comes back with zero fixes. That is the convergence rule: the audit ends at a fully clean pass, never at "fixed the flagged lines." Fixes create new problems often enough that skipping the re-run defeats the whole loop.
→ **HOLD.** A structural problem that editing cannot patch. HOLD triggers:
  → The hook promises a video the body does not contain (bait-and-switch). No sentence-level edit fixes it; the video has to be re-planned.
  → A fabricated source or event anywhere in the script, or an invented number the video leans on, or a number that still fails after a claimed source check (per the D5 boundary). Editing cannot make an invented fact true. An unverifiable-but-plausible decorative number the video does not lean on is a FIX-THEN-PASS cut, not a HOLD.
  → The script is its reference with the nouns swapped: angle, structure, and sourcing all mirror it (E3 failed on all three fronts).
  → No spine: sentences do not trace to one connecting thread (C1 fails across the script, not in spots).
  → A Group E red flag that is not a line edit: a duplicate-publishing plan or a bulk pattern has to change at the channel level, and no script edit resolves it.
  HOLD means back to the outline or back to research. Re-enter the workflow at the step that failed, and the new draft takes the full audit from the top.

**Stripping.** The verdict block is working scaffolding for the loop. On PASS, strip the block and any inline audit notes before the script is delivered as final output. The viewer-facing script carries no audit text, no flags, no brackets.

---

**Faceless Scripts OS** - The last gate between a draft and a script.
