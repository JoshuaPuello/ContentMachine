import { config } from 'dotenv';
config({ path: './.env' });
const { generateMapSegment } = await import('./lib/mapAgent.js');
const result = await generateMapSegment({
  request: {
    subject: "The Mongol invasions of Khwarezmia — Genghis Khan's armies sweep west from Mongolia into Central Asia",
    era: '1219-1221',
    geography: 'Mongolia (496) as the Mongol homeland, Kazakhstan (398), Uzbekistan (860), Turkmenistan (795) as Khwarezmia, China (156) northern context',
    beats: [
      { at: 0.1, what: 'Mongol homeland highlighted red' },
      { at: 0.4, what: 'arrows thrust west across the steppe' },
      { at: 0.65, what: 'Khwarezmia falls — territory joins the red' }
    ],
    narration_excerpt: 'In 1219, the Great Khan turned his gaze west. Two hundred thousand riders crossed the steppe, and the ancient cities of Khwarezmia — Samarkand, Bukhara, Urgench — fell one by one.',
    style: 'chronicle'
  },
  durationSeconds: 20,
  style: 'chronicle',
  sessionId: 'test_cinema',
  model: 'opus',
  mapId: 'mongol-test',
  onLog: (l) => console.log('[maplog]', l),
});
console.log('RESULT', JSON.stringify({ url: result.url, attempts: result.attempts }, null, 2));
