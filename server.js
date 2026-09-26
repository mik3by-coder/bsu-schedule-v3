const express = require('express');
const fs = require('fs');
const path = require('path');
const { parseSchedule } = require('./scheduleParser');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_URL = process.env.BSU_SOURCE_URL || 'https://sb.bsu.by/raspisanie/map-614__engl_.xml';
const REFRESH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const CACHE_FILE = path.join(__dirname, 'data', 'schedule-cache.json');

let cache = {
  schedule: [],
  sourceUpdatedAt: null,
  groupTitle: null,
  fetchedAt: null,
  status: 'starting',
  error: null
};

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(saved.schedule) && saved.schedule.length) {
      cache = { ...cache, ...saved, status: 'stale', error: null };
      console.log(`Loaded cached schedule: ${saved.schedule.length} lessons`);
    }
  } catch (error) {
    console.warn(`Could not load schedule cache: ${error.message}`);
  }
}

function saveDiskCache(nextCache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(nextCache, null, 2), 'utf8');
  } catch (error) {
    console.warn(`Could not save schedule cache: ${error.message}`);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

async function fetchSchedule() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(SOURCE_URL, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BSU-Schedule-App/2.1)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8'
      }
    });

    if (!response.ok) throw new Error(`БГУ вернул HTTP ${response.status}`);

    const html = await response.text();
    const parsed = parseSchedule(html);

    if (!parsed.schedule.length) {
      throw new Error('БГУ ответил, но занятия не найдены. Расписание не заменено.');
    }

    const nextCache = {
      schedule: parsed.schedule,
      sourceUpdatedAt: parsed.sourceUpdatedAt,
      groupTitle: parsed.groupTitle,
      fetchedAt: new Date().toISOString(),
      status: 'ok',
      error: null
    };

    cache = nextCache;
    saveDiskCache(nextCache);

    console.log(`Schedule synced: ${parsed.schedule.length} lessons; BSU update: ${parsed.sourceUpdatedAt || 'unknown'}`);
    console.log(`First: ${parsed.schedule[0].date} ${parsed.schedule[0].start} — ${parsed.schedule[0].discipline}`);
    console.log(`Last:  ${parsed.schedule.at(-1).date} ${parsed.schedule.at(-1).start} — ${parsed.schedule.at(-1).discipline}`);
  } catch (error) {
    cache = {
      ...cache,
      status: cache.schedule.length ? 'stale' : 'error',
      error: error.name === 'AbortError' ? 'БГУ не ответил вовремя.' : error.message
    };
    console.error(`Schedule sync failed: ${cache.error}`);
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/schedule', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    group: cache.groupTitle || '1курс. Бизнес-администрирование. 614 (Engl) группа. дневная',
    source: SOURCE_URL,
    timezone: 'Europe/Minsk',
    refreshMs: REFRESH_MS,
    ...cache
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: cache.status,
    lessons: cache.schedule.length,
    sourceUpdatedAt: cache.sourceUpdatedAt,
    fetchedAt: cache.fetchedAt,
    error: cache.error
  });
});

app.listen(PORT, async () => {
  loadDiskCache();
  console.log(`BSU Schedule v3.0 running at http://localhost:${PORT}`);
  await fetchSchedule();
  setInterval(fetchSchedule, REFRESH_MS);
});
