---
name: packaging
description: The optional final step after a greenlight PASS. Turns the finished script plus the research brief into a complete upload kit, title options from the proven formulas, description, tags, pinned comment, and thumbnail prompts, all in the channel's anchored voice with nothing invented. Trigger by saying "package it" on a passed script.
---

# Packaging

A script that clears the greenlight audit is a finished script, and a finished script is still not an upload. You still need a title, a description, tags, a pinned comment, and a thumbnail direction, and the usual failure is writing those cold: the script gets the full pipeline and the metadata gets thirty seconds of generic default voice. A viewer meets the metadata first. This file turns the final script into the complete upload kit, in the channel's register, with every claim traced to what the script actually says and nothing invented on top.

It runs on three inputs that already exist by this point in the workflow:

→ The final script, after `greenlight-audit-skill.md` returned PASS and the verdict block was stripped.
→ The brief from `research-and-ideation-skill.md`, specifically its TOPIC and ANGLE fields.
→ The anchor sample from `voice-anchoring-skill.md`, the same one the script was written against.

This step is optional. Skipping it changes nothing upstream. Running it means the video leaves the system uploadable instead of half-done.

---

## The upload kit

The output is this block, filled in, and nothing else:

```
TITLE OPTIONS:      [3 options, built from the patterns in title-formulas-skill.md, ranked with one line of why for the top pick]
TITLE (UNDERSCORED): [top title with spaces as underscores, for filename use]
DESCRIPTION:        [2-3 short paragraphs: hook-restate + what the video covers + keywords worked in naturally; zero slop, zero hype]
TAGS:               [comma-separated, 15-25, from the script's actual subjects and niche terms]
PINNED COMMENT:     [one comment in the channel's voice that extends the video (a detail that didn't fit, a question that drives replies); never "thanks for watching"]
THUMBNAIL PROMPTS:  [two image-generation prompts: one matching the channel's existing thumbnail style, one fresh take; each describes composition, subject, text overlay 3 words max]
```

How each field gets built:

### TITLE OPTIONS

Titles come from `title-formulas-skill.md`, never from scratch. That file already carries the frameworks with verified engagement behind them; your job here is selection and fill-in, not invention.

→ **Start from the script's format.** Match content type to framework family using that file's tables and niche sections: a downfall story reaches for the Rise and Fall family ("The Rise and Fall of X"), a business exposé reaches for the Industry Exposés section ("What [Authority Figures] DON'T Tell You About X" or "Why is EVERYONE Leaving X? (WHAT'S REALLY GOING ON?)"), a documentary can reach for the Top 10 table's top scorer, "X REGRETS: Top 5 regrets from [Experienced Group]", when the material genuinely fits it. The Quick Reference table at the bottom gives the fastest format-to-framework map.
→ **Pull the 3 options from at least 2 different framework families.** Three fills of the same skeleton is one option pretending to be three.
→ **Fill the X and Y slots from the script.** The names, the numbers, the specific entities the script actually covers. "How He Lost $47 Million" beats "How He Lost Money" only when the $47 million is in the script with its source.
→ **Keep every option under 60 characters** where possible, per that file's own writing tips.
→ **Rank them.** Option 1 is your pick, with one line of why: which framework it uses and what it has over the other two (stronger open loop, more specific proof, tighter match to the ANGLE).
→ **Check the pair, not just the title.** Title and thumbnail complement each other, they never repeat each other. Decide here what the title carries so the THUMBNAIL PROMPTS field can carry the other half.

### TITLE (UNDERSCORED)

The top-ranked title, spaces replaced with underscores, punctuation that breaks filenames stripped (slashes, colons, question marks, quotes). Purely mechanical, used for the video's project and export filenames so the whole folder matches the upload.

### DESCRIPTION

Two or three short paragraphs, written like the channel talks:

→ **Paragraph 1 restates the hook's tension** in fresh words. Same jolt, same open loop, new sentence, so a reader who lands on the description gets pulled in the same way a viewer does at second five. Never paste the hook verbatim. The first line does the work: YouTube truncates everything past roughly the first 125-150 characters behind "more," so the strongest hook-restate goes first deliberately.
→ **Paragraph 2 (and 3 if needed) states what the video covers,** in the order the script covers it, with the TOPIC's searchable words worked in where they fit naturally. The brief's TOPIC field was written in words a viewer would actually search; those words belong here, in sentences, never as a keyword pile.
→ **Zero slop, zero hype.** No "you won't believe," no adjective stacking, no promise the script does not pay off. The description is spoken copy in disguise: run it against the anchor sample like any other paragraph you would read into a microphone.

### TAGS

15 to 25, comma-separated, all traceable to the script, its brief, or its niche and format:

→ The subjects by name: people, companies, places, events the script actually covers.
→ The TOPIC's search phrasings and close variants a viewer would type.
→ The niche's standing terms and the format term (documentary, explainer, true crime) when they apply.
→ Nothing trend-jacked. A tag for something the video never mentions is an invented claim in tag form, and it teaches the algorithm to show the video to viewers who will click away.

### PINNED COMMENT

One comment, in the channel's voice, that extends the video instead of closing it. The pinned comment lands inside the same Action Window that `outro-psychology-skill.md` builds the outro around, so the same psychology governs it:

→ **One move only.** A detail that got cut for time, a sharper version of one claim, or a direct question that drives replies. Never a stack of asks, per that file's Decision Fatigue rule.
→ **A cut detail needs a source, and this is a rule, not a preference.** The detail is usable only when it sits in the brief's PROOF BANK with its source on the line. No PROOF BANK entry means no cut-detail comment: use the question that drives replies instead. A pinned comment is a public factual claim under the channel's name, and the verify-or-cut rule keeps applying when the sentence lives below the video instead of in it.
→ **Never "thanks for watching."** That is the Gratitude Trap: closure ends the interaction, and a closed viewer scrolls on. Keep the loop open.
→ **A question beats a statement** when the script left a genuine fork: "the part I could not fit: [detail from the research that traces to the PROOF BANK]. Would you have made the same call?" reads like the channel and feeds the comment section the algorithm reads.
→ If the outro already drives one CTA, the pinned comment does not repeat it. Two surfaces, two different moves.

### THUMBNAIL PROMPTS

Two image-generation prompts, each specifying composition, subject, and a text overlay of 3 words maximum:

→ **Prompt 1 matches the channel's existing thumbnail style.** Name the style concretely from real uploads (color treatment, framing, whether faces or objects dominate) so the result sits next to the back catalog without a seam. No uploads yet? Anchor to the niche, the same move `voice-anchoring-skill.md` makes for the spoken sample: name a top performer in your lane and prompt in that channel's style, stated as such ("in the style of [niche leader]'s thumbnails: ..."). Never invent an "existing style" for a channel that has none.
→ **Prompt 2 is a fresh take** on the same video: different composition or emotional angle, still honest to the content. This is the A/B candidate, not a replacement for the house look of the channel.
→ **The overlay never repeats the title.** The title carries the text hook; the thumbnail carries the visual hook, per the complement rule in `title-formulas-skill.md`. If the title asks the question, the overlay shows the stakes, and the reverse.
→ Both prompts depict only what the video contains. A thumbnail promising a scene the script never delivers is the visual version of a bait-and-switch title.

---

## Rules

The discipline layer. Every field above passes all five before the kit ships:

→ **Everything in the CHANNEL's voice.** The description and the pinned comment are spoken copy: run them against the anchor sample with the same shape test `voice-anchoring-skill.md` applies to the script, sentence by sentence. A handwritten script sitting under a generic default-voice description reads as two different authors, and the metadata is the one the viewer meets first. That mismatch burns the credibility the script just earned.
→ **Anchor the written surface too.** The spoken transcript carries no casing, punctuation, or emoji signal, so a lowercase-casual channel can get a standard-register kit that still passes the shape test. When the channel has uploads, pull 1-2 real published descriptions and pinned comments as the written-surface anchor and match their casing, punctuation, and emoji density. No uploads yet, inherit those surface conventions from the niche anchor's channel.
→ **Nothing invented.** Every claim in the description, every tag, every pinned comment, every overlay traces to the script or to a verified PROOF BANK item from the brief. No stat, name, or promise appears in the kit that does not appear in one of those two places. The verify-or-cut rule from `research-and-ideation-skill.md` applies to metadata exactly as it applies to the script: if it did not survive sourcing, it does not get resurrected in a description because the metadata "needed a number there."
→ **Title options clear the same bar as hooks.** Specific, tension-forward, zero clickbait the video cannot cash. The greenlight audit's A5 check already built a promise map from hook to body; the chosen title must map onto a payoff inside that same map. A title promising "five signs" over a script that delivers three is a bait-and-switch at the packaging layer, and it fails here for the same reason it would have failed there.
→ **No banned slop vocabulary anywhere in the kit.** The machine-ban list in `humanizer-skill.md` (Two-tier bans, machine tier) applies to titles, descriptions, tags, comments, and overlays with zero adjudication, the same as it applies to spoken copy. A banned phrase in a description is still shipped slop.

Before the kit ships, run this sweep against the filled block, top to bottom:

→ Every number in the kit traces to the script or to a verified PROOF BANK item from the brief, with the same value. A rounded or "improved" number in the title is a new unsourced number.
→ Every name in the kit is spelled the way the script spells it. Titles and tags are where misspellings go public.
→ The 3 title options really come from named frameworks in `title-formulas-skill.md`, and you can say which framework each one fills.
→ The description and pinned comment pass the shape test against the anchor sample, sentence by sentence, with no sentence waved through because it is "just metadata."
→ The tag list holds between 15 and 25 entries, and cutting any tag would remove a real subject rather than filler.
→ The two thumbnail prompts each carry all three parts: composition, subject, and an overlay of 3 words or fewer.

One clean pass through all six and the kit is done. Any miss gets fixed and the sweep re-runs from the top, same convergence logic the greenlight audit uses.

---

## Social tier (on request)

Only when the buyer asks for it, never by default. Short repurpose posts for any platforms the buyer names: X, Facebook, Instagram, Pinterest, Medium, wherever the channel distributes.

→ Each post is a native rewrite of the video's single strongest insight, the one claim or reveal the script most earns. Written to stand alone on that platform, in the channel's voice.
→ Never a link-dump announcement ("new video is up, link below"). The post delivers the insight; the video link rides along as the place to go deeper.
→ All five Rules above apply unchanged: channel voice on both surfaces, nothing invented, no slop, every claim traced to the script or the PROOF BANK.

This tier is an extension, not the core. The upload kit is complete without it.

---

## How to run it

After the greenlight audit returns PASS, say **"package it"**, or let the master workflow's packaging step invoke this file directly. Inputs: the final stripped script + the brief's TOPIC and ANGLE + the anchor sample. Output: the upload kit block, filled in, nothing else.

---

**Faceless Scripts OS** - The script is not done until it is uploadable.
