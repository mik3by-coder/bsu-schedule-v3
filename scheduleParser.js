const cheerio = require('cheerio');

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+.*)?$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const SUBGROUP_RE = /^([12])\s*подгр\.?$/i;

// Official timetable supplied by the user ("Режим учебных занятий").
// A university "pair" consists of two 40-minute parts with a 5-minute
// internal break, followed by the longer break before the next pair.
const REGIME = [
  { number: 1, parts: [['08:30', '09:10'], ['09:15', '09:55']], breakToNext: ['09:55', '10:10'] },
  { number: 2, parts: [['10:10', '10:50'], ['10:55', '11:35']], breakToNext: ['11:35', '12:05'] },
  { number: 3, parts: [['12:05', '12:45'], ['12:50', '13:30']], breakToNext: ['13:30', '13:40'] },
  { number: 4, parts: [['13:40', '14:20'], ['14:25', '15:05']], breakToNext: ['15:05', '15:15'] },
  { number: 5, parts: [['15:15', '15:55'], ['16:00', '16:40']], breakToNext: ['16:40', '17:00'] },
  { number: 6, parts: [['17:00', '17:40'], ['17:45', '18:25']], breakToNext: ['18:25', '18:35'] },
  { number: 7, parts: [['18:35', '19:15'], ['19:20', '20:00']], breakToNext: ['20:00', '20:10'] },
  { number: 8, parts: [['20:10', '20:50'], ['20:55', '21:35']], breakToNext: null }
];

const START_TO_REGIME = new Map();
for (const pair of REGIME) {
  pair.parts.forEach(([start, end], index) => {
    START_TO_REGIME.set(start, { number: pair.number, part: index + 1, start, end });
  });
}

function normalize(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toIsoDate(day, month, year) {
  return `${year}-${month}-${day}`;
}

function parseDateCell(value) {
  const text = normalize(value);
  const match = text.match(DATE_RE);
  return match ? toIsoDate(match[1], match[2], match[3]) : null;
}

function findScheduleTable($) {
  let result = null;
  $('table').each((_, table) => {
    if (result) return;
    const tableText = normalize($(table).text());
    const hasColumns = /Время/i.test(tableText)
      && /Дисциплина/i.test(tableText)
      && /Преподаватель/i.test(tableText)
      && /Аудитория/i.test(tableText);
    if (hasColumns) result = table;
  });
  return result;
}

function parseSchedule(html) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: true });
  const pageText = normalize($('body').text());
  const sourceUpdatedAt = (pageText.match(/Дата обновления\s+(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i) || [])[1] || null;
  const groupTitle = normalize($('h1').first().text()) || null;

  const table = findScheduleTable($);
  if (!table) return { schedule: [], sourceUpdatedAt, groupTitle };

  const schedule = [];
  let currentDate = null;

  $(table).find('tr').each((_, row) => {
    const cells = $(row)
      .find('th,td')
      .map((__, cell) => normalize($(cell).text()))
      .get();

    if (!cells.length) return;

    const dateFromRow = cells.map(parseDateCell).find(Boolean);
    if (dateFromRow) {
      currentDate = dateFromRow;
      if (!cells.some(cell => TIME_RE.test(cell))) return;
    }

    if (!currentDate) return;

    const timeIndex = cells.findIndex(cell => TIME_RE.test(cell));
    if (timeIndex < 0) return;

    const time = normalizeTime(cells[timeIndex]);
    const rest = cells.slice(timeIndex + 1);
    if (rest.length < 3) return;

    let subgroup = '';
    let discipline = '';
    let teacher = '';
    let room = '';

    // Normal: time | discipline | teacher | room
    // Subgroup: time | 1 подгр | discipline | teacher | room
    if (rest.length >= 4 && SUBGROUP_RE.test(rest[0])) {
      subgroup = rest[0];
      discipline = rest[1];
      teacher = rest[2];
      room = rest.slice(3).join(' ');
    } else {
      discipline = rest[0];
      teacher = rest[1];
      room = rest.slice(2).join(' ');
    }

    if (!discipline || !teacher || !room) return;

    const regime = START_TO_REGIME.get(time);
    schedule.push({
      date: currentDate,
      start: time,
      discipline,
      teacher,
      room,
      subgroup,
      period: regime ? regime.number : null,
      part: regime ? regime.part : null
    });
  });

  // The BSU source publishes start times only. For standard pair starts, use the
  // full pair end from the supplied official timetable. For exceptional starts
  // (e.g. 09:30 or 11:00), keep the 90-minute fallback because the source page
  // itself does not provide an end time.
  for (const date of [...new Set(schedule.map(item => item.date))]) {
    const lessons = schedule
      .filter(item => item.date === date)
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start) || a.teacher.localeCompare(b.teacher));

    for (let i = 0; i < lessons.length; i += 1) {
      const lesson = lessons[i];
      const regime = START_TO_REGIME.get(lesson.start);
      // The BSU source gives the start of a pair. A standard pair spans both
      // 40-minute parts with the 5-minute internal break, so its end is the
      // second part's end (for example 08:30 -> 09:55).
      const pair = regime ? REGIME.find(item => item.number === regime.number) : null;
      const nominalEnd = pair
        ? timeToMinutes(pair.parts[1][1])
        : timeToMinutes(lesson.start) + 90;

      const nextDistinctStart = lessons
        .slice(i + 1)
        .map(item => timeToMinutes(item.start))
        .find(minutes => minutes > timeToMinutes(lesson.start));

      const endMinutes = Math.min(nominalEnd, nextDistinctStart ?? nominalEnd);
      lesson.end = minutesToTime(endMinutes);
    }
  }

  schedule.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp) return dateCmp;
    const timeCmp = timeToMinutes(a.start) - timeToMinutes(b.start);
    if (timeCmp) return timeCmp;
    const subgroupCmp = a.subgroup.localeCompare(b.subgroup);
    if (subgroupCmp) return subgroupCmp;
    return a.discipline.localeCompare(b.discipline);
  });

  return { schedule, sourceUpdatedAt, groupTitle };
}

function normalizeTime(value) {
  const [h, m] = value.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = { parseSchedule, REGIME };
