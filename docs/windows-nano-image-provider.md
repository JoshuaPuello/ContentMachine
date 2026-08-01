# Windows Nano Banana image provider

ContentMachine exposes `windows-nano-banana` as a durable image provider. It
uses the same authenticated Storyforge producer API as Windows Veo video and
does not use or modify the separate Extra High `/image-tasks` worker.

## Configuration

Set the existing server-only broker variables from `backend/.env.example`.
No Nano worker credential belongs in ContentMachine; Storyforge authenticates
`windows-nano-01` independently.

The provider supports `16:9`, `9:16`, and `1:1` at `1K`, `2K`, or `4K`.
Prompt-only work sends no synthetic attachment. When ContentMachine has
continuity references, it packs them left-to-right into one board, normalizes
that board to JPEG at no more than 1 MiB, uploads it through a broker-issued
R2 session, and sends exactly one immutable reference.

## Durable flow

`backend/lib/windowsNanoImage.js` persists one independent Storyforge task per
project image in `windows-nano-image-state.json`. It retains task identity,
fingerprint, retry state, progress, and the verified Storyforge R2 result URL.
The reconciler survives ContentMachine restarts and acknowledges results only
after attaching them to the matching immutable project item.

The frontend may queue up to 80 project images concurrently. Storyforge leases
them for four renewable hours, while the Windows service runs four provider
threads internally. Extra High remains on `windowsImage.js` with its original
five-slot queue and is not affected.

## Verification

```bash
node --test backend/lib/windowsNanoImage.test.js
npm --prefix frontend run build
```
