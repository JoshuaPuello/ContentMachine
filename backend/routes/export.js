import express from 'express';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import { URL, fileURLToPath } from 'url';
import path from 'path';
import { Readable } from 'stream';
import { createReadStream, existsSync } from 'fs';
const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, '..', '..', 'output');

// Session-file URLs ("/api/session/<id>/files/<rel>", relative or absolute)
// point at files this server already has on disk — read them directly.
const sessionFilePath = (urlString) => {
  const match = String(urlString).match(/\/api\/session\/([^/]+)\/files\/(.+)$/);
  if (!match) return null;
  const [, sessionId, rel] = match;
  if (sessionId.includes('..') || rel.includes('..')) return null;
  const abs = path.join(OUTPUT_ROOT, sessionId, decodeURIComponent(rel));
  return abs.startsWith(path.join(OUTPUT_ROOT, sessionId)) && existsSync(abs) ? abs : null;
};

const getExtFromUrl = (urlString, fallback = 'jpg') => {
  try {
    const parsed = new URL(urlString);
    const ext = path.extname(parsed.pathname).replace('.', '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {}
  return fallback;
};

const fetchUrlToStream = (urlString) => {
  return new Promise((resolve, reject) => {
    if (!urlString || urlString.startsWith('data:')) {
      if (urlString?.startsWith('data:')) {
        const base64Data = urlString.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const stream = Readable.from(buffer);
        resolve(stream);
        return;
      }
      reject(new Error('Invalid URL'));
      return;
    }

    // Locally-stored session assets (audio slices, restored images) —
    // stream straight from disk, no HTTP round trip
    const localPath = sessionFilePath(urlString);
    if (localPath) {
      resolve(createReadStream(localPath));
      return;
    }
    if (urlString.startsWith('/')) {
      reject(new Error(`Local file not found for ${urlString}`));
      return;
    }

    const parsedUrl = new URL(urlString);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    protocol.get(urlString, { timeout: 60000 }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch: ${response.statusCode}`));
        return;
      }
      resolve(response);
    }).on('error', reject);
  });
};

const slugify = (text) => {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
};

const formatDateTime = () => {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `${date}_${time}`;
};

router.post('/zip', async (req, res) => {
  try {
    const project = req.body;
    
    const storyTitle = project.story?.title || 'untitled-project';
    const dateTime = formatDateTime();
    const baseName = `${slugify(storyTitle)}_${dateTime}`;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      // Headers already sent at this point — just destroy the connection
      if (!res.headersSent) {
        res.status(500).json({ error: true, message: err.message });
      } else {
        res.destroy();
      }
    });
    
    const selectedImages = project.selected_images || {};
    const allImages = project.images || {};       // keyed "scene_segment_promptIndex" (legacy: "scene_promptIndex")
    const selectedVideos = project.selected_videos || {};

    // Unit keys are "scene_segment" ("12_0", "12_1"); legacy projects used
    // plain scene numbers ("12"). Build a stable file label for either.
    const parseUnitKey = (key) => {
      const parts = String(key).split('_');
      const scene = Number(parts[0]);
      const segment = parts.length > 1 ? Number(parts[1]) || 0 : 0;
      return { scene, segment };
    };
    const unitLabel = (key) => {
      const { scene, segment } = parseUnitKey(key);
      const base = `scene_${String(scene).padStart(2, '0')}`;
      return segment > 0 ? `${base}_shot${segment + 1}` : base;
    };
    const unitSort = (a, b) => {
      const ua = parseUnitKey(a), ub = parseUnitKey(b);
      return ua.scene - ub.scene || ua.segment - ub.segment;
    };

    const unitKeys = [...new Set([
      ...Object.keys(selectedImages),
      ...Object.keys(selectedVideos),
    ])].sort(unitSort);

    const stage = (msg) => console.log(`[export:${baseName.slice(0, 24)}] ${msg}`);
    stage(`start — ${unitKeys.length} shots, ${Object.keys(allImages).length} image variants, audio scenes: ${Object.keys((project.audio || {}).sceneAudio || {}).length}`);

    // ============ IMAGES/SELECTED FOLDER ============
    for (const uk of unitKeys) {
      const image = selectedImages[uk];
      if (image?.url) {
        try {
          const stream = await fetchUrlToStream(image.url);
          const ext = image.url.startsWith('data:')
            ? (image.url.startsWith('data:image/png') ? 'png' : 'jpg')
            : getExtFromUrl(image.url, 'jpg');
          archive.append(stream, { name: `images/selected/${unitLabel(uk)}.${ext}` });
        } catch (e) {
          console.error(`Failed to fetch selected image ${uk}:`, e.message);
        }
      }
    }

    stage('selected images done');
    // ============ IMAGES/ALL FOLDER (all generated variants) ============
    for (const [key, image] of Object.entries(allImages)) {
      if (!image?.url) continue;
      // key is "scene_segment_promptIndex" (e.g. "3_0_2"); legacy "scene_promptIndex"
      const parts = key.split('_');
      const [sceneNum, segment, promptIndex] = parts.length >= 3
        ? [parts[0], Number(parts[1]) || 0, parts[2]]
        : [parts[0], 0, parts[1]];
      const variantNum = Number(promptIndex) + 1;
      const shotSuffix = segment > 0 ? `_shot${segment + 1}` : '';
      try {
        const stream = await fetchUrlToStream(image.url);
        const ext = image.url.startsWith('data:')
          ? (image.url.startsWith('data:image/png') ? 'png' : 'jpg')
          : getExtFromUrl(image.url, 'jpg');
        archive.append(stream, {
          name: `images/all/scene_${String(sceneNum).padStart(2, '0')}${shotSuffix}_v${variantNum}.${ext}`
        });
      } catch (e) {
        console.error(`Failed to fetch variant image ${key}:`, e.message);
      }
    }

    stage('image variants done');
    // ============ VIDEOS FOLDER ============
    // Write all versions for each shot: history versions first, then the
    // currently-selected one last (always named _selected so editors can
    // identify the chosen cut immediately).
    //   videos/scene_02_v1.mp4   ← oldest regenerated version
    //   videos/scene_02_v2.mp4   ← next version
    //   videos/scene_02_selected.mp4  ← currently selected (may duplicate a vN file)
    const videoHistory = project.video_history || {};
    for (const uk of unitKeys) {
      const history = videoHistory[uk] || [];
      const label = unitLabel(uk);
      // Write historical versions
      for (let i = 0; i < history.length; i++) {
        const hv = history[i];
        if (!hv?.url) continue;
        try {
          const stream = await fetchUrlToStream(hv.url);
          archive.append(stream, {
            name: `videos/${label}_v${i + 1}.mp4`
          });
        } catch (e) {
          console.error(`Failed to fetch video history ${uk} v${i + 1}:`, e.message);
        }
      }
      // Write the currently selected version
      const video = selectedVideos[uk];
      if (video?.url) {
        try {
          const stream = await fetchUrlToStream(video.url);
          const vLabel = history.length > 0
            ? `_v${history.length + 1}_selected`
            : '_selected';
          archive.append(stream, {
            name: `videos/${label}${vLabel}.mp4`
          });
        } catch (e) {
          console.error(`Failed to fetch selected video ${uk}:`, e.message);
        }
      }
    }
    
    stage('videos done');
    // ============ AUDIO FOLDER ============
    const audioData = project.audio || {};
    
    // Scene narration audio — store uses camelCase (sceneAudio), fallback to snake_case
    const sceneAudioMap = audioData.sceneAudio || audioData.scene_audio || {};
    if (Object.keys(sceneAudioMap).length > 0) {
      for (const [sceneId, sceneAudio] of Object.entries(sceneAudioMap)) {
        if (sceneAudio?.parts) {
          const audioParts = sceneAudio.parts.filter(p => p.type === 'audio');
          for (let i = 0; i < audioParts.length; i++) {
            try {
              const stream = await fetchUrlToStream(audioParts[i].content);
              archive.append(stream, { name: `audio/narration/${sceneId}_part${i + 1}.mp3` });
            } catch (e) {
              console.error(`Failed to fetch narration ${sceneId}:`, e.message);
            }
          }
        }
      }
    }
    
    // Sound effects — store uses camelCase (sfxAudio), fallback to snake_case
    const sfxAudioMap = audioData.sfxAudio || audioData.sfx_audio || {};
    if (Object.keys(sfxAudioMap).length > 0) {
      for (const [cue, sfx] of Object.entries(sfxAudioMap)) {
        if (sfx?.audio) {
          try {
            const stream = await fetchUrlToStream(sfx.audio);
            const cueName = cue.replace('[SFX:', '').replace(']', '').replace(/:/g, '_');
            archive.append(stream, { name: `audio/sfx/${cueName}.mp3` });
          } catch (e) {
            console.error(`Failed to fetch SFX ${cue}:`, e.message);
          }
        }
      }
    }
    
    // ============ THUMBNAIL FOLDER ============
    // thumbnail/selected/  — the thumbnail(s) the user explicitly picked
    // thumbnail/all/       — every generated thumbnail so none are lost
    const selectedUrls = project.thumbnail?.selected_urls || 
      (project.thumbnail?.selected_url ? [project.thumbnail.selected_url] : []);

    for (let i = 0; i < selectedUrls.length; i++) {
      const url = selectedUrls[i];
      if (!url) continue;
      try {
        const stream = await fetchUrlToStream(url);
        const ext = url.startsWith('data:')
          ? (url.startsWith('data:image/png') ? 'png' : 'jpg')
          : getExtFromUrl(url, 'jpg');
        const filename = selectedUrls.length === 1
          ? `thumbnail/selected/thumbnail.${ext}`
          : `thumbnail/selected/thumbnail_${i + 1}.${ext}`;
        archive.append(stream, { name: filename });
      } catch (e) {
        console.error(`Failed to fetch selected thumbnail ${i + 1}:`, e.message);
      }
    }

    // All generated thumbnails (the full grid, regardless of selection)
    const allThumbnails = project.all_thumbnails || [];
    for (let i = 0; i < allThumbnails.length; i++) {
      const thumb = allThumbnails[i];
      if (!thumb?.url) continue;
      try {
        const stream = await fetchUrlToStream(thumb.url);
        const ext = thumb.url.startsWith('data:')
          ? (thumb.url.startsWith('data:image/png') ? 'png' : 'jpg')
          : getExtFromUrl(thumb.url, 'jpg');
        archive.append(stream, { name: `thumbnail/all/thumbnail_${i + 1}.${ext}` });
      } catch (e) {
        console.error(`Failed to fetch thumbnail ${i + 1}:`, e.message);
      }
    }
    
    // ============ METADATA FOLDER ============
    if (project.metadata) {
      // YouTube metadata
      archive.append(JSON.stringify(project.metadata, null, 2), { name: 'metadata/youtube_metadata.json' });
      
      // Titles as plain text
      if (project.metadata.all_titles || project.metadata.titles) {
        const titles = project.metadata.all_titles || project.metadata.titles;
        const titlesText = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
        archive.append(titlesText, { name: 'metadata/titles.txt' });
      }
      
      // Description
      if (project.metadata.description) {
        archive.append(project.metadata.description, { name: 'metadata/description.txt' });
      }
      
      // Tags
      if (project.metadata.tags) {
        archive.append(project.metadata.tags.join(', '), { name: 'metadata/tags.txt' });
      }
      
      // Chapters
      if (project.metadata.chapters) {
        const chaptersText = project.metadata.chapters.map(c => `${c.timestamp} ${c.label}`).join('\n');
        archive.append(chaptersText, { name: 'metadata/chapters.txt' });
      }
    }
    
    // ============ SCRIPT FOLDER ============
    if (project.tts_script) {
      // Full script
      archive.append(project.tts_script, { name: 'script/narration.txt' });
    }
    
    // Script with cues (if available)
    if (project.tts_scene_breakdown) {
      let scriptWithCues = '';
      for (const scene of project.tts_scene_breakdown) {
        scriptWithCues += `\n=== ${scene.scene_id} (${scene.duration}s) ===\n`;
        scriptWithCues += `Delivery: ${scene.delivery_instructions || 'Standard'}\n\n`;
        for (const line of scene.lines) {
          scriptWithCues += `${line}\n`;
        }
      }
      archive.append(scriptWithCues, { name: 'script/narration_with_cues.txt' });
    }
    
    // ============ ROOT - PROJECT FILE ============
    // Restorable snapshot with base64 image data stripped out — images live as
    // real files in images/all/ and images/selected/ inside the ZIP.
    // The importer reconstructs state.images and state.selectedImages from those
    // files by matching filenames back to sceneNum_promptIndex keys.
    //
    // Strip base64 from: images (all variants), selected_images, all_thumbnails,
    // thumbnail urls, and audio (base64 audio blobs if any).
    const stripUrl = (obj) => obj ? { ...obj, url: undefined } : obj

    const projectExport = {
      ...project,
      version: 2,
      exported_at: new Date().toISOString(),
      // images: strip url, keep prompt so UI knows what was used per variant
      images: Object.fromEntries(
        Object.entries(project.images || {}).map(([k, v]) => [k, stripUrl(v)])
      ),
      // selected_images: strip url, keep prompt + promptIndex for reference
      selected_images: Object.fromEntries(
        Object.entries(project.selected_images || {}).map(([k, v]) => [k, stripUrl(v)])
      ),
      // thumbnails: strip urls — thumbnail files are written to thumbnail/ folder
      all_thumbnails: (project.all_thumbnails || []).map(t => stripUrl(t)),
      thumbnail: project.thumbnail ? {
        ...project.thumbnail,
        selected_url: undefined,
        selected_urls: undefined,
      } : null,
    };
    stage('audio + thumbnails + metadata done — writing project.json/README');
    archive.append(JSON.stringify(projectExport, null, 2), { name: 'project.json' });
    
    // README
    const readme = `# ${project.story?.title || 'Video Project'}

Generated: ${new Date().toISOString()}

## Folder Structure

- \`images/selected/\` - Chosen scene image (one per scene)
- \`images/all/\` - All generated variants for every scene (up to 4 per scene)
- \`videos/\` - All generated video versions per scene (_v1, _v2, … _selected)
- \`audio/\` - Narration and sound effects
  - \`narration/\` - Scene-by-scene voiceover
  - \`sfx/\` - Sound effects
- \`thumbnail/\` - YouTube thumbnail options
- \`metadata/\` - YouTube metadata (titles, description, tags, chapters)
- \`script/\` - Narration scripts

## Next Steps

1. Import videos into video editor
2. Add narration audio tracks
3. Overlay sound effects at marked timestamps
4. Add thumbnail
5. Upload to YouTube with metadata

## Shot Timings

${unitKeys.map(uk => {
  const video = selectedVideos[uk];
  const clip = video?.duration ? `${video.duration}s clip` : 'unknown clip';
  const target = video?.target_duration ? ` → covers ${video.target_duration}s of audio` : '';
  const rate = video?.playback_rate && video.playback_rate < 1 ? ` @ ${Math.round(video.playback_rate * 100)}% speed` : '';
  return `- ${unitLabel(uk)}: ${clip}${rate}${target}`;
}).join('\n')}
`;
    archive.append(readme, { name: 'README.md' });

    stage('finalizing zip...');
    await archive.finalize();
    stage(`done — ${archive.pointer()} bytes`);

  } catch (error) {
    console.error('Export error:', error.stack || error);
    // The archive streams directly into the response — once streaming has
    // begun we can't send a JSON error anymore, only abort the download
    if (!res.headersSent) {
      res.status(500).json({ error: true, message: error.message, code: 'EXPORT_ERROR' });
    } else {
      res.destroy();
    }
  }
});

export default router;
