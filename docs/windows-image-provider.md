# Windows Extra High image provider

Content Machine can use the shared StoryForge control plane to generate images
through the independent Windows Chrome worker.

## Configuration

Configure only the backend:

```env
MEDIA_BROKER_URL=https://storyforge.example.com
MEDIA_BROKER_PRODUCER_ID=content-machine
MEDIA_BROKER_PRODUCER_TOKEN=replace-with-the-content-machine-caller-secret
MEDIA_BROKER_PROTOCOL_VERSION=1
MEDIA_BROKER_REQUEST_TIMEOUT_MS=30000
MEDIA_BROKER_IMAGE_POLL_INTERVAL_MS=5000
```

The existing Content Machine R2 settings are also required. No worker or R2
credential is exposed to the browser.

## Generic task adapter

`backend/lib/windowsImage.js` is asset-type agnostic. It accepts:

- a stable project and item ID;
- one creative prompt;
- one or two ordered reference images;
- an output count from one to three;
- priority and scalar metadata.

It stages immutable references in the project R2 namespace, creates four-hour
signed downloads and per-output signed uploads, submits one durable idempotent
task, validates every completed R2 object by count, ordinal, SHA-256, byte
length, and dimensions, and preserves every alternative.

The backend reconciler continues polling sidecar task state after the browser
closes or reloads.

## Adapters

- **Continuity scene sheets:** reference 1 is the exact layout template;
  reference 2 is a deterministic left-to-right character board when needed.
  Generated alternatives receive layout validation before selection.
- **Individual scene images and character portraits:** reference 1 is a
  structural canvas; reference 2 packs ordered character references when
  needed. Five independent tasks are queued before waiting so all Windows tabs
  can work concurrently.

The same generic service can later back thumbnails or other project assets by
providing a new stable item ID, prompt, references, metadata, and a
Content-Machine-specific result adapter. It does not contain sheet-only
assumptions.

Windows owns provider retries while a task is non-terminal. Content Machine
does not submit replacements during those retries. A terminal retry creates a
new revision while preserving the previous alternatives.

## Desktop-worker guarantees used by the adapter

The integration depends only on the generic v1 contract, not ChatGPT DOM
details or scene-sheet behavior:

- reference ordinals are authoritative and remain unchanged through staging;
- each logical result set has one stable task ID and idempotency key;
- one task requests exactly one, two, or three independent outputs;
- five independent tasks may be active, while native tab preparation remains
  serialized inside the Windows worker;
- every phase except `complete` and `failed` remains non-terminal;
- Content Machine never retries a non-terminal task;
- completion is accepted only after all expected ordinals are present,
  uniquely hashed, uploaded, and independently verified from R2.

The Windows provider may show a generic error banner while valid outputs are
still being produced. That UI detail is intentionally invisible here:
Content Machine follows only the durable broker lifecycle and validated output
manifest. Future adapters (for example thumbnails) reuse the same task service
and provide only their own prompt, references, result-application rules, and
UI.
