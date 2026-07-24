# ContentMachine Cinema Integration — Design

**Date:** 2026-07-18 · **Status:** approved for implementation (user directive: build until done)
**Repos involved:** ContentMachine (`~/IdeaProjects/Personal/ContentMachine`) + StoryForge (`~/IdeaProjects/Personal/storyforge`)

## Goal

Turn ContentMachine from "generate clips + ZIP" into an end-to-end cinematic
documentary studio in the **Fern house style** (dark starfield, neon-framed
archival portraits, Cormorant Garamond serif caps, dashed-line motifs, the
Epic-History-style relief maps): a smart Director stage places library
effects/maps/chapters with restraint, a real timeline editor lets the user
manage everything, and a full local Remotion render produces the final
YouTube-ready MP4. Optional movie-trailer cold open and chapter system.
Projects view makes it a real platform.

## Architecture (decided)

**StoryForge = the render engine. ContentMachine = the studio.**
ContentMachine's backend spawns renders inside the StoryForge repo (path via
`STORYFORGE_PATH` in backend/.env, default `~/IdeaProjects/Personal/storyforge`).
No Remotion is added to ContentMachine; all compositions/effects live in
StoryForge where the whole library already exists.

### New StoryForge pieces

1. `src/modules/remotion-docmaster/` — **DocumentaryMaster** composition:
   takes one big `timeline.json` prop and renders the entire film:
   - ordered shot clips (`OffthreadVideo`, per-clip `playbackRate`, trimmed to
     `targetDuration`) with transition treatments (hard cut / 8-frame
     crossfade / dip-to-black)
   - narration audio per scene (`Audio` with `startFrom` offsets)
   - overlay items: text titles/lower-thirds (Cormorant Garamond theme),
     adaptive-effect segments, pre-rendered map MP4s (OffthreadVideo overlay),
     chapter stingers (ChapterStinger component inline), trailer intro
     (micro-clips + TitleReveal), date chips, grain+vignette master texture
   - `calculateMetadata` derives duration from the timeline JSON.
2. `src/modules/remotion-chapters/` — **ChapterStinger** (DONE: reveal +
   active modes, verified against the Fern reference).
3. **TitleReveal** component (in remotion-docmaster): elegant serif title on
   starfield — letter-tracking expansion + soft glow bloom, optional
   subtitle/eyebrow. Used for trailer intro climax + anywhere the Director
   wants a title card.
4. `EpicMapCustom` composition (in remotion-epic-map Root): EpicMapScene
   already takes camera/fills/labels/arrows/grade as props — register a
   composition whose props come 100% from input JSON (`--props`), so map
   agents produce **data**, never code.
5. `tools/epic-map/bake-highlight.mjs` — on-demand sprite baker:
   `node tools/epic-map/bake-highlight.mjs --name <slug> --ids 156,392
   --color red|teal --variants archival,obsidian [--poly <json>]` → bakes
   only that highlight sprite(s) + patches geometry.json/geometry.generated.ts.
   Lets map agents highlight ANY country combo without a full rebake.
6. Render library registration (Task 9): epic-map scenarios + chapter stinger
   as gallery assets with product names (see Naming) + channel-style mapping.

### New ContentMachine pieces

1. **Timeline model + store slice** (`frontend/src/lib/timeline.js` +
   store additions): `timeline = { items: TimelineItem[], version }`.
   `TimelineItem = { id, kind, startTime, endTime, label, payload, locked? }`
   kinds: `'clip' | 'narration' | 'map' | 'chapter' | 'intro' | 'title' |
   'lower-third' | 'effect' | 'texture'`. Base video+narration items are
   derived from selections (auto-synced); Director adds overlay items; the
   editor edits them. Serialized into session/project save.
2. **Director stage** (`backend/routes/director.js` + skill): after videos
   are selected, `POST /api/director/plan` runs claude CLI (model from
   settings) with the **documentary-director skill** inlined as system
   prompt + the full script/scene/audio/chapter context → returns a
   validated placement plan (maps with full epic-map scenario JSON specs,
   chapter breaks, title cards, lower thirds, trailer shot picks) →
   frontend merges into timeline (user-editable).
   - Map items: each placement then runs the **map-author loop**
     (`backend/lib/mapAgent.js`): claude -p **opus** with epic-map skill
     content inlined → scenario JSON → bake-highlight if needed → render 3
     stills → claude review pass against the skill checklist → fix → ≤3
     iterations → render map MP4 via `EpicMapCustom` → store in session
     `maps/`. Goal: right at try 1 (the skill carries the detail).
3. **Editor step** (`/editor` route between Videos and Export):
   `frontend/src/pages/EditorTimeline.jsx` + components — borrowed patterns
   from StoryForge remix-timeline (ruler, playhead, zoom, snap,
   drag/move/resize via pointer px→seconds) rebuilt in ContentMachine's
   stack. Preview: **SequencePlayer** — virtual playback across ordered shot
   clips (per-clip playbackRate) + scene narration audio sync + overlay
   badges/poster frames for map/chapter/effect items (full fidelity is the
   render's job; the editor is for arrangement and timing).
4. **Render stage** (`backend/routes/render.js`): `POST /api/render/start` —
   stages all assets to `output/<session>/render/` (downloads selected clip
   URLs, narration parts, map MP4s, chapter images), writes `timeline.json`
   (translating store timeline → DocumentaryMaster props), spawns
   `npx remotion render src/modules/remotion-docmaster/remotion-entry.ts
   DocumentaryMaster out.mp4 --props=... --concurrency=...` with
   `cwd=STORYFORGE_PATH`, streams progress (poll endpoint `GET
   /api/render/status`), finishes into `output/<session>/final/<slug>.mp4`
   + exposes download. Export page gets a "Render Final Film" panel with
   progress + preview of the finished MP4 (ZIP export stays).
5. **Chapters (optional setting `chaptersEnabled`)**: scene-planning prompt
   injection — story structured into 3-5 chapters `{ chapter_number, title,
   character_name, character_description }` mapped to scene ranges; chapter
   portrait prompts generated + images created via the configured image
   provider (test: vertex flash lite); reveal stinger after intro + active
   stinger at each chapter start (timeline items).
6. **Trailer intro (optional setting `trailerIntroEnabled`)**: Director
   picks 4-6 peak shots (post-video-selection so real clips exist) → intro
   timeline item: micro-cuts (~1.8-2.2s each, accelerating rhythm,
   dip-to-black beats) → TitleReveal with the story title.
7. **Projects view**: landing route `/projects` (Layout home): cards from
   `GET /api/session/list` (name, date, step progress, thumbnail from
   session files), New Project (fresh session id + reset store), open
   (restore), rename (`PATCH /api/session/:id/name` — new endpoint),
   delete. Header shows current project name (editable).
8. **Settings additions**: `chaptersEnabled` (default off),
   `trailerIntroEnabled` (default off), `cinemaStyle`
   (`'chronicle' | 'heritage' | 'nocturne'` — the map/overlay style variant,
   default chronicle), Director model picker (reuses claudeProvider/model).

### Skills (quality carriers — must let weak models produce great output)

- StoryForge: `.claude/skills/epic-map/SKILL.md` (exists; the map-author
  inlines it).
- ContentMachine: `.claude/skills/documentary-director/SKILL.md` — the
  Director grammar: Fern-grade principles (restraint: ≤1 overlay focal
  element at a time; maps only for real geography beats ≥12s of narration;
  recurring dashed-line motif; portraits as framed artifacts; serif chip
  date/number treatment; texture always; motivated motion only), exact
  placement JSON schema, timing rules (map 12-30s, stinger 8s reveal/5s
  active, title 4-6s, lower-third 5-8s), and worked examples.
- ContentMachine: `.claude/skills/map-author/SKILL.md` — how to write an
  epic-map scenario JSON for EpicMapCustom (prop schema, camera/zoom rules
  of thumb from the epic-map skill §5, bake-highlight usage, review
  checklist). References but does not duplicate the epic-map skill.

### Naming (render library + user-facing styles)

Map style variants get product names everywhere user-facing:
`archival → Chronicle`, `atlas → Heritage`, `obsidian → Nocturne`.
Gallery assets: "Chronicle Map — Rise of Empires", "Chronicle Map — Theater
of War", "Chapter Constellation" (stinger), "Title Bloom" (TitleReveal).
Channel-style mapping in the gallery: historical/documentary → Chronicle,
editorial → Heritage, true-crime/tactical → Nocturne.

## Test protocol (after implementation)

Settings: LLM = claude-cli/opus · images = vertex flash lite · video =
GeminiGen grok-3 (6 or 10s) · speed 80% · 2 variations. Chapters ON,
trailer ON, style Chronicle. Create a 2-minute story through the real UI
(Chrome automation), audio via ElevenLabs if key present else synthetic
placeholder TTS (fallback: generate spoken-word audio via `say` +
ffmpeg to mp3 for timing realism), select images/videos by eye, run
Director, inspect timeline, render final MP4, verify frame-by-frame
(smoothness, sync, typography, no seams), iterate until excellent.

## Milestones / task map

Tasks #9 (library reg), #11 (docmaster+bridge), #12 (director+map agents),
#13 (editor UI), #14 (trailer), #15 (chapters), #16 (projects), #17 (E2E).
ChapterStinger + reference analyses complete. This doc is the single source
of architectural truth — update it if decisions change.
