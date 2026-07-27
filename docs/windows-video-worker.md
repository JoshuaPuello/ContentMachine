# Windows Veo generation

Content Machine can use the existing StoryForge media-worker control plane as
its shared broker. The browser talks only to Content Machine. Content Machine
uploads an immutable source-image snapshot through a broker-issued signed R2
PUT, enqueues `media.image-to-video`, persists the task in
`output/<sessionId>/media-worker-state.json`, and reconciles results in the
background. The Windows worker and Veo bridge remain unchanged.

Set the `MEDIA_BROKER_*` variables documented in `backend/.env.example`. The
producer token is server-only and must differ from the Windows worker token.
The `windows-worker` route supports the proven adapter contract only: 8 seconds,
16:9, 720p provider output, silent video, and at most four active jobs globally.

Generated evidence is stored in `video_jobs[unitId]`. Editorial selection in
`selected_videos[unitId]` is never changed by broker completion.

The project setting `videoGenerationBackend` is the rollback flag:
`windows-worker` selects this route and `hosted-provider` keeps the existing
fal, Replicate, or GeminiGen path. Content Machine currently uses an atomic
JSON project store and an in-process per-session mutation lock, so this backend
must run as one writer process (one PM2 instance). Moving the session store and
locks to a transactional database is the planned prerequisite for horizontal
multi-writer scaling, not for the current single-instance deployment.

## API

Browser calls require `X-Content-Machine-Session-Token`, the current project
write token returned by session load/save. This prevents another local/browser
client from enqueueing, canceling, or attaching media to a guessed session ID.

- `POST /api/videos/windows/generate` — `{sessionId, unitIds}`
- `GET /api/videos/windows/status/:sessionId`
- `POST /api/videos/windows/pause` — `{sessionId, reason?}`
- `POST /api/videos/windows/resume` — `{sessionId}`
- `POST /api/videos/windows/retry-missing` — `{sessionId}`
- `POST /api/videos/windows/cancel` — `{sessionId, reason?}`
- `POST /api/videos/manual-attach` — multipart `sessionId`, `unitId`, MP4 `file`

Pause and deletion are scoped to the exact `content-machine` project at the
broker and cannot cancel StoryForge work. The reconciler resumes after backend
restart, rejects stale image/prompt/settings completions, and performs at most
two automatic repair passes. Manual retry resets that budget.

Set `MEDIA_BROKER_UPLOAD_HOSTS` to the exact account-specific R2 hostname that
the broker uses for signed producer-input uploads. Signed URLs are credentials:
they are never logged, redirects are rejected, and the producer bearer token is
sent only to the broker origin.

## Rollback

Select any hosted provider (`fal`, `replicate`, or `geminigen`) for new work,
cancel Content Machine-owned Windows tasks, and preserve all completed videos.
Do not change the Windows worker URL or credentials.
