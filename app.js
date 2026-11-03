/* 减脂记录 —— 应用逻辑
   纯前端、零依赖、无网络请求。数据存 IndexedDB。 */

(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const DB_NAME = 'fitness-tracker';
  const DB_VERSION = 1;
  const DAY_MS = 86400000;

  const MEAL_DEFS = [
    { key: 'breakfast', label: '早餐' },
    { key: 'lunch', label: '午餐' },
    { key: 'dinner', label: '晚餐' },
    { key: 'snack', label: '加餐' }
  ];
  const MEAL_TAGS = ['外食', '吃多了', '油炸', '甜食', '饮酒'];
  const EXERCISE_TYPES = ['快走', '跑步', '骑行', '力量训练', '瑜伽拉伸', '游泳', '跳绳', '球类', '其他'];
  const INTENSITY_DEFS = [
    { key: 'low', label: '轻' },
    { key: 'mid', label: '中' },
    { key: 'high', label: '高' }
  ];
  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const MEASURE_DEFS = [
    { key: 'bust', label: '胸围', color: 'var(--c-bust)' },
    { key: 'waist', label: '腰围', color: 'var(--c-waist)' },
    { key: 'hip', label: '臀围', color: 'var(--c-hip)' }
  ];
  const METRIC_DEFS = [
    { key: 'morning', label: '晨重', color: 'var(--c-morning)' },
    { key: 'noon', label: '午间', color: 'var(--c-noon)' },
    { key: 'evening', label: '晚间', color: 'var(--c-evening)' },
    { key: 'avg', label: '日均', color: 'var(--c-morning)' }
  ];
  const AVG_COLOR = 'var(--c-avg)';

  /* =========================================================
     纯函数层：日期、统计、格式化。可在 Node 中单独测试。
     ========================================================= */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function fromKey(key) {
    const parts = String(key).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function todayKey() { return toKey(new Date()); }

  function addDays(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }

  function diffDays(aKey, bKey) {
    return Math.round((fromKey(aKey) - fromKey(bKey)) / DAY_MS);
  }

  function weekdayOf(key) { return fromKey(key).getDay(); }

  function startOfWeek(key) {
    return addDays(key, -((weekdayOf(key) + 6) % 7));
  }

  function formatMonthDay(key) {
    const d = fromKey(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function formatShort(key) {
    const d = fromKey(key);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatFull(key) {
    const d = fromKey(key);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function relativeLabel(key) {
    const t = todayKey();
    const delta = diffDays(key, t);
    if (delta === 0) return '今天';
    if (delta === -1) return '昨天';
    if (delta === -2) return '前天';
    if (delta === 1) return '明天';
    return '';
  }

  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function parseNum(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function mean(values) {
    const list = values.filter(function (v) { return typeof v === 'number' && Number.isFinite(v); });
    if (!list.length) return null;
    let sum = 0;
    for (const v of list) sum += v;
    return sum / list.length;
  }

  function dayAverage(day) {
    if (!day || !day.weights) return null;
    return mean([day.weights.morning, day.weights.noon, day.weights.evening]);
  }

  /** 把按日期升序的 days 转成某个口径的折线点。 */
  function seriesFor(days, metric) {
    const out = [];
    for (const day of days) {
      let value = null;
      if (metric === 'avg') value = dayAverage(day);
      else if (day.weights) value = day.weights[metric];
      if (typeof value === 'number' && Number.isFinite(value)) {
        out.push({ date: day.date, value: value });
      }
    }
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  /** 尾部滑动平均：以每个点当天为终点、向前 window 个自然日。默认至少 3 个样本才输出。 */
  function movingAverage(points, windowSize, minCount) {
    const win = windowSize || 7;
    const min = minCount === undefined ? 3 : minCount;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const end = points[i];
      const bucket = [];
      for (let j = i; j >= 0; j--) {
        const gap = diffDays(end.date, points[j].date);
        if (gap >= win) break;
        bucket.push(points[j].value);
      }
      if (bucket.length >= min) {
        out.push({ date: end.date, value: round1(mean(bucket)), n: bucket.length });
      }
    }
    return out;
  }

  /** 最新值相对 cutoff 之前最近一次记录的变化。 */
  function changeOverDays(points, days, endKey) {
    const end = endKey || todayKey();
    const pts = points.filter(function (p) { return p.date <= end; });
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1];
    const cutoff = addDays(last.date, -days);
    let ref = null;
    for (const p of pts) {
      if (p.date <= cutoff) ref = p; else break;
    }
    if (!ref || ref.date === last.date) return null;
    return { delta: round1(last.value - ref.value), from: ref, to: last };
  }

  /** 本周（周一起算）内的变化。 */
  function changeInWeek(points, today) {
    const end = today || todayKey();
    const ws = startOfWeek(end);
    const pts = points.filter(function (p) { return p.date >= ws && p.date <= end; });
    if (pts.length < 2) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    return { delta: round1(last.value - first.value), from: first, to: last };
  }

  function bmiValue(kg, cm) {
    if (!kg || !cm) return null;
    const m = cm / 100;
    return round1(kg / (m * m));
  }

  function bmiCategory(b) {
    if (b === null || b === undefined) return '';
    if (b < 18.5) return '偏瘦';
    if (b < 24) return '正常';
    if (b < 28) return '超重';
    return '肥胖';
  }

  function healthyRange(cm) {
    if (!cm) return null;
    const m = cm / 100;
    return { min: round1(18.5 * m * m), max: round1(23.9 * m * m) };
  }

  /** 最近 spanDays 天内的平均速度，单位 kg/周。 */
  function linearRate(points, spanDays) {
    const span = spanDays || 30;
    if (points.length < 2) return null;
    const last = points[points.length - 1];
    const cutoff = addDays(last.date, -(span - 1));
    let first = null;
    for (const p of points) {
      if (p.date >= cutoff) { first = p; break; }
    }
    if (!first || first.date === last.date) return null;
    const days = diffDays(last.date, first.date);
    if (days <= 0) return null;
    return {
      perWeek: round2((last.value - first.value) / days * 7),
      days: days,
      from: first,
      to: last
    };
  }

  function daysWithData(days) {
    let n = 0;
    for (const day of days) if (hasAnyData(day)) n++;
    return n;
  }

  function hasAnyData(day) {
    if (!day) return false;
    const w = day.weights || {};
    if (w.morning || w.noon || w.evening) return true;
    const m = day.measurements || {};
    if (m.bust || m.waist || m.hip) return true;
    const meals = day.meals || {};
    for (const def of MEAL_DEFS) {
      const meal = meals[def.key];
      if (meal && ((meal.text && meal.text.trim()) || (meal.tags && meal.tags.length) || (meal.photos && meal.photos.length))) return true;
    }
    if (day.exercises && day.exercises.length) return true;
    if (day.note && String(day.note).trim()) return true;
    return false;
  }

  /** 生成每周重复的日历提醒（.ics，浮动本地时间，不依赖时区）。 */
  function buildIcs(opts) {
    const options = opts || {};
    const weekday = typeof options.weekday === 'number' ? options.weekday : 6;
    const time = /^\d{2}:\d{2}$/.test(options.time || '') ? options.time : '09:00';
    const summary = options.summary || '测量三围';
    const description = options.description || '记录胸围、腰围、臀围。';
    const startKey = options.startKey || todayKey();

    const d = fromKey(startKey);
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
    const datePart = toKey(d).replace(/-/g, '');
    const startStamp = datePart + 'T' + time.replace(':', '') + '00';

    const hh = Number(time.slice(0, 2));
    const mm = Number(time.slice(3, 5));
    const endTotal = (hh * 60 + mm + 30) % 1440;
    const endStamp = datePart + 'T' + pad2(Math.floor(endTotal / 60)) + pad2(endTotal % 60) + '00';

    const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const byday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][weekday];

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//fitness-tracker//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:ft-measure-' + datePart + '-' + weekday + '@fitness-tracker',
      'DTSTAMP:' + nowStamp,
      'DTSTART:' + startStamp,
      'DTEND:' + endStamp,
      'RRULE:FREQ=WEEKLY;BYDAY=' + byday,
      'SUMMARY:' + summary,
      'DESCRIPTION:' + description,
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + summary,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      ''
    ];
    return lines.join('\r\n');
  }

  const FT = {
    pad2: pad2, toKey: toKey, fromKey: fromKey, todayKey: todayKey, addDays: addDays,
    diffDays: diffDays, weekdayOf: weekdayOf, startOfWeek: startOfWeek,
    formatMonthDay: formatMonthDay, formatShort: formatShort, formatFull: formatFull,
    relativeLabel: relativeLabel, round1: round1, round2: round2, clamp: clamp,
    parseNum: parseNum, mean: mean, dayAverage: dayAverage, seriesFor: seriesFor,
    movingAverage: movingAverage, changeOverDays: changeOverDays, changeInWeek: changeInWeek,
    bmiValue: bmiValue, bmiCategory: bmiCategory, healthyRange: healthyRange,
    linearRate: linearRate, daysWithData: daysWithData, hasAnyData: hasAnyData,
    buildIcs: buildIcs,
    MEAL_DEFS: MEAL_DEFS, MEAL_TAGS: MEAL_TAGS, MEASURE_DEFS: MEASURE_DEFS,
    METRIC_DEFS: METRIC_DEFS, EXERCISE_TYPES: EXERCISE_TYPES, INTENSITY_DEFS: INTENSITY_DEFS
  };
  if (typeof globalThis !== 'undefined') globalThis.FT = FT;

  /* =========================================================
     备份打包：无依赖 store-only ZIP（JPEG 已是压缩格式，不再二次压缩）
     ========================================================= */

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(bytes) {
    const table = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosStamp(date) {
    const d = date || new Date();
    const year = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
      date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }

  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  function zipCreate(entries) {
    const encoder = new TextEncoder();
    const body = [];
    const central = [];
    let offset = 0;
    const stamp = dosStamp(new Date());

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data;
      const checksum = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      body.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const cdBytes = concatChunks(central);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdBytes.length, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return concatChunks([concatChunks(body), cdBytes, eocd]);
  }

  function findEocd(bytes) {
    const min = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    return -1;
  }

  /** 解析 zip 目录表，返回条目元信息。 */
  function zipParse(bytes) {
    const eocd = findEocd(bytes);
    if (eocd < 0) throw new Error('这不是有效的 zip 文件');
    const ev = new DataView(bytes.buffer, bytes.byteOffset + eocd);
    const count = ev.getUint16(10, true);
    let cursor = ev.getUint32(16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = [];

    for (let i = 0; i < count; i++) {
      const cv = new DataView(bytes.buffer, bytes.byteOffset + cursor);
      if (cv.getUint32(0, true) !== 0x02014b50) throw new Error('zip 目录表损坏');
      const method = cv.getUint16(10, true);
      const compSize = cv.getUint32(20, true);
      const rawSize = cv.getUint32(24, true);
      const nameLen = cv.getUint16(28, true);
      const extraLen = cv.getUint16(30, true);
      const commentLen = cv.getUint16(32, true);
      const localOffset = cv.getUint32(42, true);
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, rawSize: rawSize, localOffset: localOffset });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function zipReadEntry(bytes, entry) {
    const lv = new DataView(bytes.buffer, bytes.byteOffset + entry.localOffset);
    if (lv.getUint32(0, true) !== 0x04034b50) throw new Error('zip 条目损坏');
    const nameLen = lv.getUint16(26, true);
    const extraLen = lv.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    return bytes.subarray(start, start + entry.compSize);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  /** 解出 zip 内所有条目（支持本应用生成的 store-only，也尽量兼容 deflate）。 */
  async function zipExtract(bytes) {
    const entries = zipParse(bytes);
    const out = [];
    for (const entry of entries) {
      if (entry.name.slice(-1) === '/') continue;
      const raw = zipReadEntry(bytes, entry);
      let data = raw;
      if (entry.method === 8) {
        const inflated = await inflateRaw(raw);
        if (!inflated) throw new Error('备份使用了压缩格式，当前浏览器无法解压，请用本应用导出的 zip');
        data = inflated;
      } else if (entry.method !== 0) {
        throw new Error('不支持的压缩方式');
      }
      out.push({ name: entry.name, data: data });
    }
    return out;
  }

  FT.crc32 = crc32;
  FT.zipCreate = zipCreate;
  FT.zipParse = zipParse;
  FT.zipExtract = zipExtract;

  /* =========================================================
     存储层：IndexedDB（days / photos / settings）
     ========================================================= */

  const DB = (function () {
    let opened = null;

    function open() {
      if (opened) return opened;
      opened = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains('days')) {
            db.createObjectStore('days', { keyPath: 'date' });
          }
          if (!db.objectStoreNames.contains('photos')) {
            const store = db.createObjectStore('photos', { keyPath: 'id' });
            store.createIndex('date', 'date', { unique: false });
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('无法打开数据库')); };
        req.onblocked = function () { reject(new Error('数据库被其他标签页占用')); };
      });
      return opened;
    }

    function reqPromise(request) {
      return new Promise(function (resolve, reject) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }

    function read(name, fn) {
      return open().then(function (db) {
        return reqPromise(fn(db.transaction(name, 'readonly').objectStore(name)));
      });
    }

    function write(names, fn) {
      const list = Array.isArray(names) ? names : [names];
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(list, 'readwrite');
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error); };
          try {
            fn(list.map(function (n) { return tx.objectStore(n); }));
          } catch (err) {
            try { tx.abort(); } catch (e) { /* 忽略 */ }
            reject(err);
          }
        });
      });
    }

    return {
      getDay: function (date) { return read('days', function (s) { return s.get(date); }); },
      allDays: function () { return read('days', function (s) { return s.getAll(); }); },
      putDay: function (day) { return write('days', function (stores) { stores[0].put(day); }); },
      putDays: function (days) { return write('days', function (stores) { days.forEach(function (d) { stores[0].put(d); }); }); },
      deleteDay: function (date) { return write('days', function (stores) { stores[0].delete(date); }); },
      getPhoto: function (id) { return read('photos', function (s) { return s.get(id); }); },
      allPhotos: function () { return read('photos', function (s) { return s.getAll(); }); },
      putPhotos: function (photos) { return write('photos', function (stores) { photos.forEach(function (p) { stores[0].put(p); }); }); },
      putPhoto: function (photo) { return write('photos', function (stores) { stores[0].put(photo); }); },
      deletePhoto: function (id) { return write('photos', function (stores) { stores[0].delete(id); }); },
      getSettings: function () { return read('settings', function (s) { return s.get('app'); }); },
      putSettings: function (value) { return write('settings', function (stores) { stores[0].put(value); }); },
      importBundle: function (days, photos, replace) {
        return write(['days', 'photos'], function (stores) {
          if (replace) { stores[0].clear(); stores[1].clear(); }
          days.forEach(function (d) { stores[0].put(d); });
          photos.forEach(function (p) { stores[1].put(p); });
        });
      },
      clearAll: function () {
        return write(['days', 'photos', 'settings'], function (stores) {
          stores.forEach(function (s) { s.clear(); });
        });
      }
    };
  })();

  const DEFAULT_SETTINGS = {
    key: 'app',
    heightCm: null,
    startWeight: null,
    targetWeight: null,
    targetDate: '',
    weekMeasureDay: 6,
    theme: 'auto'
  };

  const state = {
    date: todayKey(),
    day: null,
    days: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    activeTab: 'today',
    range: 30,
    metric: 'morning',
    importMode: 'merge',
    measureOpen: false,
    saving: false,
    saveTimer: null,
    toastTimer: null,
    installEvent: null,
    photoUrls: new Map()
  };

  /* =========================================================
     通用小工具
     ========================================================= */

  function $(id) { return document.getElementById(id); }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(null, args); }, ms);
    };
  }

  function toast(message) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-on');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, 1400);
  }

  function formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function fileStamp() {
    return todayKey().replace(/-/g, '');
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'auto';
  }

  function normalizeDay(raw) {
    const date = raw && raw.date ? raw.date : state.date;
    const day = {
      date: date,
      weights: { morning: null, noon: null, evening: null },
      measurements: { bust: null, waist: null, hip: null },
      meals: {},
      exercises: [],
      note: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    if (raw) {
      if (raw.weights) {
        ['morning', 'noon', 'evening'].forEach(function (k) {
          const v = parseNum(raw.weights[k]);
          day.weights[k] = v === null ? null : round1(v);
        });
      }
      if (raw.measurements) {
        ['bust', 'waist', 'hip'].forEach(function (k) {
          const v = parseNum(raw.measurements[k]);
          day.measurements[k] = v === null ? null : round1(v);
        });
      }
      MEAL_DEFS.forEach(function (def) {
        const src = raw.meals && raw.meals[def.key] ? raw.meals[def.key] : {};
        day.meals[def.key] = {
          text: typeof src.text === 'string' ? src.text : '',
          tags: Array.isArray(src.tags) ? src.tags.slice() : [],
          photos: Array.isArray(src.photos) ? src.photos.slice() : []
        };
      });
      if (Array.isArray(raw.exercises)) {
        day.exercises = raw.exercises.map(function (item) {
          return {
            id: item && item.id ? String(item.id) : uid(),
            type: item && item.type ? String(item.type) : EXERCISE_TYPES[0],
            minutes: parseNum(item && item.minutes),
            intensity: item && item.intensity ? String(item.intensity) : 'mid',
            note: item && item.note ? String(item.note) : ''
          };
        });
      }
      if (typeof raw.note === 'string') day.note = raw.note;
      if (raw.createdAt) day.createdAt = raw.createdAt;
      if (raw.updatedAt) day.updatedAt = raw.updatedAt;
    } else {
      MEAL_DEFS.forEach(function (def) {
        day.meals[def.key] = { text: '', tags: [], photos: [] };
      });
    }
    return day;
  }

  function blankExercise() {
    return { id: uid(), type: EXERCISE_TYPES[0], minutes: null, intensity: 'mid', note: '' };
  }

  /* =========================================================
     照片：压缩 + 缩略图 + 对象 URL 缓存
     ========================================================= */

  async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file); } catch (err) { /* 退回 img 方案 */ }
    }
    return new Promise(function (resolve, reject) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('图片压缩失败'));
      }, type, quality);
    });
  }

  async function resizeTo(bitmap, maxEdge, quality) {
    const sw = bitmap.width || bitmap.naturalWidth;
    const sh = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob: blob, width: w, height: h };
  }

  async function compressImage(file) {
    const bitmap = await loadBitmap(file);
    try {
      const full = await resizeTo(bitmap, 1280, 0.75);
      const thumb = await resizeTo(bitmap, 240, 0.7);
      return { blob: full.blob, thumb: thumb.blob, width: full.width, height: full.height };
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function photoUrl(id, blob) {
    if (state.photoUrls.has(id)) return state.photoUrls.get(id);
    const url = URL.createObjectURL(blob);
    state.photoUrls.set(id, url);
    return url;
  }

  FT.normalizeDay = normalizeDay;

  /* =========================================================
     数据加载与保存
     ========================================================= */

  function sortedDays() {
    return state.days.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  function upsertDay(day) {
    const idx = state.days.findIndex(function (d) { return d.date === day.date; });
    if (idx >= 0) state.days[idx] = day; else state.days.push(day);
  }

  function removeDay(date) {
    const idx = state.days.findIndex(function (d) { return d.date === date; });
    if (idx >= 0) state.days.splice(idx, 1);
  }

  function series(metric) { return seriesFor(sortedDays(), metric); }

  function scheduleSave() {
    state.saving = true;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      flushSave();
    }, 500);
  }

  async function flushSave() {
    const day = state.day;
    if (!day) return;
    day.updatedAt = Date.now();
    try {
      if (hasAnyData(day)) {
        await DB.putDay(day);
        upsertDay(day);
      } else {
        await DB.deleteDay(day.date);
        removeDay(day.date);
      }
      state.saving = false;
      renderTopbarMeta();
      toast('已保存');
    } catch (err) {
      state.saving = false;
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  async function flushPending() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      await flushSave();
    }
  }

  async function loadStore() {
    const results = await Promise.all([DB.allDays(), DB.getSettings()]);
    state.days = (results[0] || []).map(function (d) { return normalizeDay(d); });
    state.settings = Object.assign({}, DEFAULT_SETTINGS, results[1] || {});
  }

  async function openDate(key) {
    await flushPending();
    state.date = key;
    const found = state.days.find(function (d) { return d.date === key; });
    state.day = found ? normalizeDay(found) : normalizeDay(null);
    if (!found) {
      MEAL_DEFS.forEach(function (def) {
        state.day.meals[def.key] = { text: '', tags: [], photos: [] };
      });
    }
    renderToday();
  }

  /* =========================================================
     今天：渲染
     ========================================================= */

  function renderToday() {
    renderDayBar();
    renderTopbarMeta();
    renderWeightFields();
    renderMeasureFields();
    renderMeals();
    renderExercises();
    $('day-note').value = state.day.note || '';
  }

  function renderTopbarMeta() {
    const node = $('topbar-meta');
    if (!node) return;
    const total = daysWithData(state.days);
    node.textContent = total ? '已记 ' + total + ' 天' : '本地存储';
  }

  function renderDayBar() {
    const key = state.date;
    const rel = relativeLabel(key);
    $('day-label-main').textContent = rel || formatMonthDay(key);
    $('day-label-sub').textContent = formatMonthDay(key) + ' ' + WEEKDAY_NAMES[weekdayOf(key)];
    $('day-next').disabled = diffDays(key, todayKey()) >= 0;
    $('day-picker').value = key;

    const chips = $('day-chips').querySelectorAll('[data-jump]');
    const delta = diffDays(key, todayKey());
    chips.forEach(function (chip) {
      const target = Number(chip.getAttribute('data-jump'));
      chip.classList.toggle('is-on', target === delta && delta >= -2);
    });
  }

  function renderWeightFields() {
    ['morning', 'noon', 'evening'].forEach(function (metric) {
      const input = $('w-' + metric);
      const value = state.day.weights[metric];
      if (document.activeElement !== input) input.value = value === null ? '' : String(value);
    });
    updateWeightNote();
  }

  function updateWeightNote() {
    const node = $('weight-note');
    const value = state.day.weights.morning;
    if (value === null) {
      node.textContent = '晨重建议固定条件测量：早起、排空、空腹、同一台秤。';
      node.className = 'note';
      return;
    }
    const points = series('morning').filter(function (p) { return p.date < state.date; });
    if (!points.length) {
      node.textContent = '这是第一条晨重记录，会作为起点。';
      node.className = 'note';
      return;
    }
    const prev = points[points.length - 1];
    const delta = round1(value - prev.value);
    const sign = delta > 0 ? '+' : '';
    node.textContent = '较上次记录（' + formatMonthDay(prev.date) + '）：' + sign + delta.toFixed(1) + ' kg';
    node.className = 'note ' + (delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '');
  }

  function renderMeasureFields() {
    MEASURE_DEFS.forEach(function (def) {
      const input = $('m-' + def.key);
      const value = state.day.measurements[def.key];
      if (document.activeElement !== input) input.value = value === null ? '' : String(value);
    });
    const flag = $('measure-flag');
    const measured = MEASURE_DEFS.some(function (def) {
      return state.day.measurements[def.key] !== null && state.day.measurements[def.key] !== undefined;
    });
    const weekStart = startOfWeek(todayKey());
    const measuredThisWeek = sortedDays().some(function (day) {
      if (day.date < weekStart) return false;
      return MEASURE_DEFS.some(function (def) { return day.measurements[def.key] !== null && day.measurements[def.key] !== undefined; });
    });
    flag.hidden = measuredThisWeek;
    const body = $('measure-body');
    const toggle = $('measure-toggle');
    const shouldOpen = state.measureOpen || (!measuredThisWeek && state.date === todayKey() && !measured);
    body.hidden = !shouldOpen;
    toggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function renderMeals() {
    const host = $('meals');
    const html = MEAL_DEFS.map(function (def) {
      const meal = state.day.meals[def.key];
      const tags = MEAL_TAGS.map(function (tag) {
        const on = meal.tags.indexOf(tag) >= 0 ? ' is-on' : '';
        return '<button type="button" class="tagbtn' + on + '" data-meal-tag="' + escapeHtml(def.key) + '" data-tag="' + escapeHtml(tag) + '">' + escapeHtml(tag) + '</button>';
      }).join('');
      const photos = meal.photos.map(function (id) {
        return '<button type="button" class="thumb" data-photo="' + escapeHtml(id) + '" aria-label="查看照片"><img alt="餐点照片" data-photo-img="' + escapeHtml(id) + '"></button>';
      }).join('');
      return [
        '<section class="card meal" data-meal="' + escapeHtml(def.key) + '">',
        '  <div class="meal__top"><span class="meal__label">' + escapeHtml(def.label) + '</span>',
        '  <span class="card__hint">' + (meal.photos.length ? meal.photos.length + ' 张照片' : '') + '</span></div>',
        '  <textarea rows="2" data-meal-text="' + escapeHtml(def.key) + '" placeholder="吃了什么？一句话就行"></textarea>',
        '  <div class="meal__tags">' + tags + '</div>',
        '  <div class="meal__photos">' + photos +
             '<button type="button" class="photo-add" data-meal-photo="' + escapeHtml(def.key) + '"><span>+</span><span>拍照</span></button>',
        '  </div>',
        '</section>'
      ].join('\n');
    }).join('\n');
    host.innerHTML = html;

    MEAL_DEFS.forEach(function (def) {
      const area = host.querySelector('[data-meal-text="' + def.key + '"]');
      area.value = state.day.meals[def.key].text || '';
      area.addEventListener('input', function () {
        state.day.meals[def.key].text = area.value;
        scheduleSave();
      });
    });

    host.querySelectorAll('[data-meal-tag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mealKey = btn.getAttribute('data-meal-tag');
        const tag = btn.getAttribute('data-tag');
        const meal = state.day.meals[mealKey];
        const idx = meal.tags.indexOf(tag);
        if (idx >= 0) meal.tags.splice(idx, 1); else meal.tags.push(tag);
        btn.classList.toggle('is-on');
        scheduleSave();
      });
    });

    host.querySelectorAll('[data-meal-photo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pickPhotos(btn.getAttribute('data-meal-photo'));
      });
    });

    host.querySelectorAll('[data-photo]').forEach(function (btn) {
      btn.addEventListener('click', function () { openLightbox(btn.getAttribute('data-photo')); });
    });

    fillPhotoThumbs(host);
  }

  async function fillPhotoThumbs(host) {
    const slots = host.querySelectorAll('[data-photo-img]');
    for (const img of slots) {
      const id = img.getAttribute('data-photo-img');
      const record = await getPhotoRecord(id);
      if (!record) { img.alt = '照片已丢失'; continue; }
      img.src = photoUrl(id, record.thumb || record.blob);
    }
  }

  async function getPhotoRecord(id) {
    if (state.photoCache && state.photoCache.has(id)) return state.photoCache.get(id);
    const record = await DB.getPhoto(id);
    if (record) {
      if (!state.photoCache) state.photoCache = new Map();
      state.photoCache.set(id, record);
    }
    return record;
  }

  /* ---------- 照片选择 ---------- */

  let photoInput = null;
  let photoTarget = null;

  function ensurePhotoInput() {
    if (photoInput) return photoInput;
    photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.multiple = true;
    photoInput.style.display = 'none';
    photoInput.addEventListener('change', function () {
      const files = Array.prototype.slice.call(photoInput.files || []);
      photoInput.value = '';
      if (files.length && photoTarget) handlePhotoFiles(photoTarget, files);
    });
    document.body.appendChild(photoInput);
    return photoInput;
  }

  function pickPhotos(mealKey) {
    photoTarget = mealKey;
    ensurePhotoInput().click();
  }

  async function handlePhotoFiles(mealKey, files) {
    const meal = state.day.meals[mealKey];
    let added = 0;
    for (const file of files) {
      if (!file.type || file.type.indexOf('image/') !== 0) continue;
      if (meal.photos.length + added >= 8) { toast('每餐最多 8 张照片'); break; }
      try {
        const packed = await compressImage(file);
        const id = uid();
        const record = {
          id: id, date: state.day.date, mealKey: mealKey,
          blob: packed.blob, thumb: packed.thumb,
          width: packed.width, height: packed.height,
          size: packed.blob.size, createdAt: Date.now()
        };
        await DB.putPhoto(record);
        state.photoCache = state.photoCache || new Map();
        state.photoCache.set(id, record);
        meal.photos.push(id);
        added++;
      } catch (err) {
        toast('照片处理失败：' + (err && err.message ? err.message : '未知错误'));
      }
    }
    if (added) {
      scheduleSave();
      renderMeals();
      refreshStorageInfo();
      toast('已添加 ' + added + ' 张照片');
    }
  }

  function openLightbox(id) {
    getPhotoRecord(id).then(function (record) {
      if (!record) { toast('照片已丢失'); return; }
      const box = $('lightbox');
      $('lightbox-img').src = photoUrl(id, record.blob);
      $('lightbox-img').alt = '餐点照片';
      $('lightbox-delete').setAttribute('data-photo', id);
      box.hidden = false;
    });
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lightbox-img').removeAttribute('src');
  }

  async function deletePhoto(id) {
    for (const def of MEAL_DEFS) {
      const meal = state.day.meals[def.key];
      const idx = meal.photos.indexOf(id);
      if (idx >= 0) meal.photos.splice(idx, 1);
    }
    try { await DB.deletePhoto(id); } catch (err) { /* 忽略 */ }
    if (state.photoUrls.has(id)) {
      URL.revokeObjectURL(state.photoUrls.get(id));
      state.photoUrls.delete(id);
    }
    if (state.photoCache) state.photoCache.delete(id);
    closeLightbox();
    scheduleSave();
    renderMeals();
    refreshStorageInfo();
    toast('照片已删除');
  }

  /* ---------- 运动 ---------- */

  function renderExercises() {
    const host = $('exercise-list');
    if (!state.day.exercises.length) {
      host.innerHTML = '<p class="ex-empty">还没有运动记录，点右上角“+ 添加”。</p>';
      return;
    }
    host.innerHTML = state.day.exercises.map(function (item) {
      const types = EXERCISE_TYPES.map(function (t) {
        return '<option value="' + escapeHtml(t) + '"' + (t === item.type ? ' selected' : '') + '>' + escapeHtml(t) + '</option>';
      }).join('');
      const levels = INTENSITY_DEFS.map(function (level) {
        const on = item.intensity === level.key ? ' is-on' : '';
        return '<button type="button" class="' + on.trim() + '" data-ex-level="' + escapeHtml(item.id) + '" data-level="' + level.key + '">' + level.label + '</button>';
      }).join('');
      return [
        '<div class="ex-row" data-ex="' + escapeHtml(item.id) + '">',
        '  <div class="ex-row__main">',
        '    <select data-ex-type="' + escapeHtml(item.id) + '">' + types + '</select>',
        '    <input type="number" inputmode="numeric" step="1" min="1" max="600" placeholder="分钟" data-ex-min="' + escapeHtml(item.id) + '" value="' + (item.minutes === null ? '' : item.minutes) + '">',
        '    <input type="text" placeholder="备注" data-ex-note="' + escapeHtml(item.id) + '" value="' + escapeHtml(item.note) + '">',
        '  </div>',
        '  <div class="ex-row__foot">',
        '    <div class="segmented segmented--sm" role="group" aria-label="强度">' + levels + '</div>',
        '    <button type="button" class="ex-del" data-ex-del="' + escapeHtml(item.id) + '">删除</button>',
        '  </div>',
        '</div>'
      ].join('\n');
    }).join('\n');

    bindExerciseEvents(host);
    renderExerciseTotal();
  }

  function findExercise(id) {
    return state.day.exercises.find(function (item) { return item.id === id; });
  }

  function bindExerciseEvents(host) {
    host.querySelectorAll('[data-ex-type]').forEach(function (select) {
      select.addEventListener('change', function () {
        const item = findExercise(select.getAttribute('data-ex-type'));
        if (item) { item.type = select.value; scheduleSave(); }
      });
    });
    host.querySelectorAll('[data-ex-min]').forEach(function (input) {
      input.addEventListener('input', function () {
        const item = findExercise(input.getAttribute('data-ex-min'));
        if (item) { item.minutes = parseNum(input.value); scheduleSave(); renderExerciseTotal(); }
      });
    });
    host.querySelectorAll('[data-ex-note]').forEach(function (input) {
      input.addEventListener('input', function () {
        const item = findExercise(input.getAttribute('data-ex-note'));
        if (item) { item.note = input.value; scheduleSave(); }
      });
    });
    host.querySelectorAll('[data-ex-level]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-ex-level');
        const item = findExercise(id);
        if (!item) return;
        item.intensity = btn.getAttribute('data-level');
        const group = btn.parentElement;
        group.querySelectorAll('button').forEach(function (other) { other.classList.remove('is-on'); });
        btn.classList.add('is-on');
        scheduleSave();
      });
    });
    host.querySelectorAll('[data-ex-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-ex-del');
        const idx = state.day.exercises.findIndex(function (item) { return item.id === id; });
        if (idx >= 0) state.day.exercises.splice(idx, 1);
        scheduleSave();
        renderExercises();
      });
    });
  }

  function renderExerciseTotal() {
    const node = $('exercise-source');
    const total = state.day.exercises.reduce(function (sum, item) {
      return sum + (typeof item.minutes === 'number' ? item.minutes : 0);
    }, 0);
    if (!state.day.exercises.length) { node.hidden = true; return; }
    node.hidden = false;
    node.textContent = '今天共 ' + total + ' 分钟 · ' + state.day.exercises.length + ' 项运动';
  }

  /* =========================================================
     趋势：原生 SVG 折线图
     ========================================================= */

  const CHART = { w: 340, h: 200, padL: 38, padR: 12, padT: 14, padB: 26, breakGap: 3 };

  function chartDomain(lines) {
    let min = Infinity;
    let max = -Infinity;
    lines.forEach(function (line) {
      line.points.forEach(function (p) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      });
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max - min < 1) {
      const mid = (max + min) / 2;
      min = mid - 0.5;
      max = mid + 0.5;
    }
    const padding = (max - min) * 0.14;
    return { min: min - padding, max: max + padding };
  }

  function linePath(points, xOf, yOf) {
    let d = '';
    let prev = null;
    points.forEach(function (p) {
      const px = xOf(p.date).toFixed(1);
      const py = yOf(p.value).toFixed(1);
      if (prev === null || diffDays(p.date, prev) > CHART.breakGap) d += ' M' + px + ' ' + py;
      else d += ' L' + px + ' ' + py;
      prev = p.date;
    });
    return d.trim();
  }

  function drawChart(container, spec) {
    const lines = (spec.lines || []).filter(function (line) { return line.points && line.points.length; });
    if (!lines.length) {
      container.innerHTML = '<svg viewBox="0 0 340 140" role="img" aria-label="暂无数据"><text class="empty" x="170" y="76" text-anchor="middle">还没有数据，去「今天」记一笔</text></svg>';
      return;
    }

    const allKeys = [];
    lines.forEach(function (line) {
      line.points.forEach(function (p) { allKeys.push(p.date); });
    });
    const start = spec.start && allKeys.indexOf(spec.start) < 0 ? spec.start : allKeys.reduce(function (a, b) { return a < b ? a : b; });
    const end = spec.end && allKeys.indexOf(spec.end) < 0 ? spec.end : allKeys.reduce(function (a, b) { return a > b ? a : b; });
    const domain = { start: spec.start || start, end: spec.end || end };
    if (domain.start > domain.end) { const t = domain.start; domain.start = domain.end; domain.end = t; }

    const span = Math.max(1, diffDays(domain.end, domain.start));
    const innerW = CHART.w - CHART.padL - CHART.padR;
    const innerH = CHART.h - CHART.padT - CHART.padB;
    const scale = chartDomain(lines);

    function xOf(key) { return CHART.padL + (diffDays(key, domain.start) / span) * innerW; }
    function yOf(value) { return CHART.padT + (1 - (value - scale.min) / (scale.max - scale.min)) * innerH; }

    let marks = '';
    for (let i = 0; i <= 3; i++) {
      const value = scale.min + (scale.max - scale.min) * (i / 3);
      const y = yOf(value);
      marks += '<line class="grid-line" x1="' + CHART.padL + '" y1="' + y.toFixed(1) + '" x2="' + (CHART.w - CHART.padR) + '" y2="' + y.toFixed(1) + '"></line>';
      marks += '<text class="axis-text" x="' + (CHART.padL - 6) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + value.toFixed(1) + '</text>';
    }

    const xLabels = [domain.start, addDays(domain.start, Math.round(span / 2)), domain.end];
    xLabels.forEach(function (key, i) {
      const anchor = i === 0 ? 'start' : i === 1 ? 'middle' : 'end';
      const x = i === 0 ? CHART.padL : i === 1 ? CHART.padL + innerW / 2 : CHART.w - CHART.padR;
      marks += '<text class="axis-text" x="' + x.toFixed(1) + '" y="' + (CHART.h - 8) + '" text-anchor="' + anchor + '">' + formatShort(key) + '</text>';
    });

    let body = '';
    lines.forEach(function (line) {
      const d = linePath(line.points, xOf, yOf);
      if (d) {
        body += '<path class="series' + (line.dash ? ' series--avg' : '') + '" d="' + d + '" stroke="' + line.color + '"></path>';
      }
      if (line.showPoints !== false && line.points.length <= 120) {
        line.points.forEach(function (p) {
          body += '<circle class="pt" cx="' + xOf(p.date).toFixed(1) + '" cy="' + yOf(p.value).toFixed(1) + '" r="2.6" fill="' + line.color + '"></circle>';
        });
      }
    });

    const svg = [
      '<svg viewBox="0 0 ' + CHART.w + ' ' + CHART.h + '" role="img" aria-label="' + escapeHtml(spec.label || '趋势图') + '">',
      '<line class="axis-line" x1="' + CHART.padL + '" y1="' + (CHART.h - CHART.padB) + '" x2="' + (CHART.w - CHART.padR) + '" y2="' + (CHART.h - CHART.padB) + '"></line>',
      marks,
      body,
      '<g class="cursor" style="display:none">',
      '  <line class="cursor-line" y1="' + CHART.padT + '" y2="' + (CHART.h - CHART.padB) + '"></line>',
      '  <rect class="tip-box" rx="6" width="104" height="20"></rect>',
      '  <text class="tip-text" x="8" y="14"></text>',
      '</g>',
      '<rect class="hit" x="0" y="0" width="' + CHART.w + '" height="' + CHART.h + '" fill="transparent"></rect>',
      '</svg>'
    ].join('');

    container.innerHTML = svg;

    const node = container.querySelector('svg');
    const cursor = node.querySelector('.cursor');
    const cursorLine = node.querySelector('.cursor-line');
    const tipBox = node.querySelector('.tip-box');
    const tipText = node.querySelector('.tip-text');

    function nearest(dateKey) {
      let best = null;
      let bestGap = Infinity;
      lines.forEach(function (line) {
        line.points.forEach(function (p) {
          const gap = Math.abs(diffDays(p.date, dateKey));
          if (gap < bestGap) { bestGap = gap; best = { line: line, point: p }; }
        });
      });
      return bestGap <= 2 ? best : null;
    }

    function showAt(clientX) {
      const rect = node.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const svgX = ratio * CHART.w;
      const days = Math.round(((svgX - CHART.padL) / innerW) * span);
      const dateKey = addDays(domain.start, clamp(days, 0, span));
      const found = nearest(dateKey);
      if (!found) { cursor.style.display = 'none'; return; }
      const x = xOf(found.point.date);
      const y = yOf(found.point.value);
      cursor.style.display = '';
      cursorLine.setAttribute('x1', x.toFixed(1));
      cursorLine.setAttribute('x2', x.toFixed(1));
      const label = formatShort(found.point.date) + '  ' + found.point.value.toFixed(1) + (spec.unit || '');
      tipText.textContent = label;
      const boxW = Math.max(80, label.length * 7.2 + 16);
      tipBox.setAttribute('width', boxW.toFixed(1));
      const tipX = clamp(x - boxW / 2, CHART.padL - 6, CHART.w - CHART.padR - boxW);
      const tipY = clamp(y - 28, 2, CHART.h - 30);
      tipBox.setAttribute('x', tipX.toFixed(1));
      tipBox.setAttribute('y', tipY.toFixed(1));
      tipText.setAttribute('x', (tipX + 8).toFixed(1));
      tipText.setAttribute('y', (tipY + 14).toFixed(1));
    }

    node.addEventListener('pointerdown', function (event) { showAt(event.clientX); });
    node.addEventListener('pointermove', function (event) {
      if (event.pointerType === 'mouse' || event.buttons) showAt(event.clientX);
    });
    node.addEventListener('pointerup', function () { cursor.style.display = 'none'; });
    node.addEventListener('pointercancel', function () { cursor.style.display = 'none'; });
    node.addEventListener('pointerleave', function () { cursor.style.display = 'none'; });
  }

  function renderLegend(host, items) {
    host.innerHTML = items.map(function (item) {
      const style = item.dash
        ? 'background:none;color:' + item.color + ';background-image:linear-gradient(90deg,' + item.color + ' 55%,transparent 0);background-size:7px 3px;background-repeat:repeat-x;'
        : 'background:' + item.color + ';';
      return '<span><i style="' + style + '"></i>' + escapeHtml(item.label) + (item.value ? ' <b>' + escapeHtml(item.value) + '</b>' : '') + '</span>';
    }).join('');
  }

  function rangeStart(days, range) {
    const today = todayKey();
    if (range === 'all') {
      return days.length ? sortedDays()[0].date : today;
    }
    return addDays(today, -(Number(range) - 1));
  }

  function renderTrend() {
    const all = sortedDays();
    const start = rangeStart(all, state.range);
    const inRange = all.filter(function (d) { return d.date >= start; });

    const metricDef = METRIC_DEFS.find(function (d) { return d.key === state.metric; }) || METRIC_DEFS[0];
    const raw = seriesFor(inRange, state.metric);
    const avg = movingAverage(raw, 7, 3);

    const lines = [];
    if (raw.length) lines.push({ key: 'raw', label: metricDef.label, color: metricDef.color, points: raw });
    if (avg.length) lines.push({ key: 'avg', label: '7 日平均', color: AVG_COLOR, points: avg, dash: true, showPoints: false });

    drawChart($('weight-chart'), {
      lines: lines,
      start: start,
      end: todayKey(),
      unit: ' kg',
      label: '体重趋势'
    });

    const legendItems = [];
    if (raw.length) legendItems.push({ label: metricDef.label, color: metricDef.color });
    if (avg.length) legendItems.push({ label: '7 日平均', color: AVG_COLOR, dash: true });
    renderLegend($('weight-legend'), legendItems.length ? legendItems : [{ label: '暂无数据', color: 'var(--line-2)' }]);

    renderStats();

    const measureLines = MEASURE_DEFS.map(function (def) {
      const points = [];
      inRange.forEach(function (day) {
        const value = day.measurements ? day.measurements[def.key] : null;
        if (typeof value === 'number' && Number.isFinite(value)) points.push({ date: day.date, value: value });
      });
      return { key: def.key, label: def.label, color: def.color, points: points };
    }).filter(function (line) { return line.points.length; });

    drawChart($('measure-chart'), {
      lines: measureLines,
      start: start,
      end: todayKey(),
      unit: ' cm',
      label: '三围趋势'
    });

    if (measureLines.length) {
      const last = measureLines.map(function (line) {
        const p = line.points[line.points.length - 1];
        return { label: line.label, color: line.color, value: p.value.toFixed(1) };
      });
      renderLegend($('measure-legend'), last);
    } else {
      renderLegend($('measure-legend'), [{ label: '暂无数据', color: 'var(--line-2)' }]);
    }
  }

  function statCard(label, value, unit, tone) {
    const cls = tone === 'down' ? ' down' : tone === 'up' ? ' up' : '';
    return '<div class="stat"><div class="stat__k">' + escapeHtml(label) + '</div>' +
      '<div class="stat__v' + cls + '">' + escapeHtml(value) + (unit ? '<small>' + escapeHtml(unit) + '</small>' : '') + '</div></div>';
  }

  function toneOf(delta) {
    if (delta === null || delta === undefined) return '';
    return delta < 0 ? 'down' : delta > 0 ? 'up' : '';
  }

  function renderStats() {
    const points = series('morning');
    const week = changeInWeek(points, todayKey());
    const month = changeOverDays(points, 30, todayKey());
    const total = points.length >= 2 ? round1(points[points.length - 1].value - points[0].value) : null;
    const signed = function (v) { return v === null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1); };

    const html = [
      statCard('本周变化', signed(week ? week.delta : null), week ? 'kg' : '', toneOf(week ? week.delta : null)),
      statCard('30 天变化', signed(month ? month.delta : null), month ? 'kg' : '', toneOf(month ? month.delta : null)),
      statCard('累计变化', signed(total), total === null ? '' : 'kg', toneOf(total)),
      statCard('记录天数', String(daysWithData(sortedDays())), '天', '')
    ].join('');
    $('stats').innerHTML = html;
  }

  /* =========================================================
     目标
     ========================================================= */

  function setValueIfIdle(id, value) {
    const node = $(id);
    if (!node) return;
    if (document.activeElement === node) return;
    node.value = value === null || value === undefined ? '' : value;
  }

  function latestWeight() {
    const points = series('morning');
    if (points.length) return { value: points[points.length - 1].value, date: points[points.length - 1].date };
    const days = sortedDays();
    for (let i = days.length - 1; i >= 0; i--) {
      const avg = dayAverage(days[i]);
      if (avg !== null) return { value: round1(avg), date: days[i].date };
    }
    return null;
  }

  function renderGoal() {
    const s = state.settings;
    setValueIfIdle('g-height', s.heightCm);
    setValueIfIdle('g-start', s.startWeight);
    setValueIfIdle('g-target', s.targetWeight);
    setValueIfIdle('g-date', s.targetDate);
    setValueIfIdle('g-weekday', String(s.weekMeasureDay));
    renderGoalProgress();
    renderGoalBmi();
    renderGoalForecast();
  }

  function renderGoalProgress() {
    const host = $('goal-progress');
    const s = state.settings;
    const points = series('morning');
    const current = latestWeight();
    const start = s.startWeight !== null && s.startWeight !== undefined ? s.startWeight : (points.length ? points[0].value : null);
    const target = s.targetWeight;

    if (current === null || start === null || target === null || target === undefined) {
      host.innerHTML = '<p class="note">填好起始体重和目标体重，这里会显示进度条。</p>';
      return;
    }

    const done = round1(start - current.value);
    const need = round1(start - target);
    const remain = round1(current.value - target);
    const pct = need === 0 ? 100 : clamp(done / need * 100, 0, 100);

    const rows = [
      '<div class="progress-head"><b>' + (done > 0 ? '已减 ' + done.toFixed(1) : '还需努力') + '</b><span class="card__hint">进度 ' + pct.toFixed(0) + '%</span></div>',
      '<div class="progress-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>',
      '<div class="progress-foot"><span>起始 ' + start.toFixed(1) + ' kg</span><span>目标 ' + target.toFixed(1) + ' kg</span></div>',
      '<div class="kv" style="margin-top:10px"><span>需要减掉</span><span>' + need.toFixed(1) + ' kg</span></div>',
      '<div class="kv"><span>还差</span><span>' + (remain > 0 ? remain.toFixed(1) + ' kg' : '已达成') + '</span></div>'
    ];
    if (current.date) {
      rows.push('<div class="kv"><span>当前体重（' + formatMonthDay(current.date) + '）</span><span>' + current.value.toFixed(1) + ' kg</span></div>');
    }
    host.innerHTML = rows.join('');
  }

  function renderGoalBmi() {
    const host = $('goal-bmi');
    const current = latestWeight();
    const cm = state.settings.heightCm;
    if (!current || !cm) {
      host.innerHTML = '<p class="note">填好身高，这里会显示 BMI 和健康体重区间。</p>';
      return;
    }
    const bmi = bmiValue(current.value, cm);
    const range = healthyRange(cm);
    host.innerHTML = [
      '<div class="grid grid--3" style="margin-bottom:10px">',
      statCard('BMI', bmi.toFixed(1), '', ''),
      statCard('评价', bmiCategory(bmi), '', ''),
      statCard('健康区间', range.min.toFixed(1) + '–' + range.max.toFixed(1), 'kg', ''),
      '</div>',
      '<p class="note">中国成人标准：18.5–23.9 为正常范围，24 以上为超重，28 以上为肥胖。</p>'
    ].join('');
  }

  function renderGoalForecast() {
    const host = $('goal-forecast');
    const current = latestWeight();
    if (!current) {
      host.innerHTML = '<p class="note">有至少两次晨重记录后，这里会估算达成目标的日期。</p>';
      return;
    }
    const rate = linearRate(series('morning'), 30);
    const target = state.settings.targetWeight;
    const rows = [];

    if (rate) {
      const perWeek = rate.perWeek;
      rows.push('<div class="kv"><span>最近 ' + rate.days + ' 天速度</span><span>' + (perWeek > 0 ? '+' : '') + perWeek.toFixed(2) + ' kg / 周</span></div>');
      if (target !== null && target !== undefined) {
        if (perWeek < -0.05) {
          const days = Math.ceil((current.value - target) / (-perWeek / 7));
          if (days > 0 && days < 3650) {
            rows.push('<div class="kv"><span>按目前速度预计达成</span><span>' + formatFull(addDays(todayKey(), days)) + '</span></div>');
          } else {
            rows.push('<div class="kv"><span>按目前速度预计达成</span><span>三到十年，建议加快一点</span></div>');
          }
        } else if (current.value <= target) {
          rows.push('<div class="kv"><span>目标状态</span><span>已达成</span></div>');
        } else {
          rows.push('<div class="kv"><span>按目前速度预计达成</span><span>暂时看不出下降趋势</span></div>');
        }
      }
    } else {
      rows.push('<p class="note">最近 30 天的记录还不够两次，暂时无法估算速度。</p>');
    }

    if (target !== null && target !== undefined && state.settings.targetDate && current.value > target) {
      const leftDays = diffDays(state.settings.targetDate, todayKey());
      if (leftDays > 0) {
        const needPerWeek = (current.value - target) / (leftDays / 7);
        rows.push('<div class="kv"><span>要在 ' + formatMonthDay(state.settings.targetDate) + ' 前达成</span><span>每周需减 ' + needPerWeek.toFixed(2) + ' kg</span></div>');
      } else {
        rows.push('<div class="kv"><span>目标日期</span><span>已经过去了</span></div>');
      }
    }

    const points = series('morning');
    if (points.length && points[points.length - 1].date) {
      rows.push('<div class="kv"><span>数据截止</span><span>' + formatFull(points[points.length - 1].date) + '</span></div>');
    }
    host.innerHTML = rows.join('');
  }

  /* =========================================================
     数据：存储、备份、恢复、提醒
     ========================================================= */

  async function refreshStorageInfo() {
    const host = $('storage-info');
    if (!host) return;
    const days = sortedDays();
    let usage = 0;
    let quota = 0;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        usage = est.usage || 0;
        quota = est.quota || 0;
      } catch (err) { /* 忽略 */ }
    }
    let photoCount = 0;
    let photoBytes = 0;
    try {
      const photos = await DB.allPhotos();
      photoCount = photos.length;
      photoBytes = photos.reduce(function (sum, p) { return sum + (p.size || (p.blob ? p.blob.size : 0)); }, 0);
    } catch (err) { /* 忽略 */ }

    host.innerHTML = [
      '<div class="kv"><span>记录天数</span><span>' + daysWithData(days) + ' 天</span></div>',
      '<div class="kv"><span>照片</span><span>' + photoCount + ' 张 · ' + formatBytes(photoBytes) + '</span></div>',
      '<div class="kv"><span>本机占用</span><span>' + formatBytes(usage) + (quota ? ' / 可用 ' + formatBytes(quota) : '') + '</span></div>'
    ].join('');
  }

  function collectPhotoMeta() {
    const meta = [];
    const seen = new Set();
    sortedDays().forEach(function (day) {
      MEAL_DEFS.forEach(function (def) {
        (day.meals[def.key].photos || []).forEach(function (id) {
          if (seen.has(id)) return;
          seen.add(id);
          const cached = state.photoCache ? state.photoCache.get(id) : null;
          meta.push({
            id: id,
            date: day.date,
            mealKey: def.key,
            width: cached ? cached.width : 0,
            height: cached ? cached.height : 0,
            createdAt: cached ? cached.createdAt : null
          });
        });
      });
    });
    return meta;
  }

  function backupBundle() {
    return {
      app: 'fitness-tracker',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      days: sortedDays(),
      photos: collectPhotoMeta()
    };
  }

  function exportJson() {
    const text = JSON.stringify(backupBundle(), null, 1);
    downloadBlob(new Blob([text], { type: 'application/json' }), '减脂记录-备份-' + fileStamp() + '.json');
    toast('已导出轻量备份');
  }

  async function exportZip() {
    const encoder = new TextEncoder();
    const entries = [{ name: 'backup.json', data: encoder.encode(JSON.stringify(backupBundle(), null, 1)) }];
    const photos = await DB.allPhotos();
    for (const photo of photos) {
      entries.push({ name: 'photos/' + photo.id + '.jpg', data: new Uint8Array(await photo.blob.arrayBuffer()) });
      if (photo.thumb) {
        entries.push({ name: 'thumbs/' + photo.id + '.jpg', data: new Uint8Array(await photo.thumb.arrayBuffer()) });
      }
    }
    const bytes = zipCreate(entries);
    downloadBlob(new Blob([bytes], { type: 'application/zip' }), '减脂记录-完整备份-' + fileStamp() + '.zip');
    toast('已导出完整备份（' + photos.length + ' 张照片）');
  }

  function baseName(name) {
    return String(name || '').split('/').pop();
  }

  async function readBackupFile(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!isZip) {
      const text = new TextDecoder('utf-8').decode(bytes);
      return { bundle: JSON.parse(text), blobs: new Map(), thumbs: new Map() };
    }
    const entries = await zipExtract(bytes);
    const decoder = new TextDecoder('utf-8');
    let bundle = null;
    const blobs = new Map();
    const thumbs = new Map();
    for (const entry of entries) {
      if (entry.name === 'backup.json' || (entry.name.slice(-5) === '.json' && !bundle)) {
        bundle = JSON.parse(decoder.decode(entry.data));
      } else if (entry.name.indexOf('photos/') === 0) {
        blobs.set(baseName(entry.name).replace(/\.jpg$/i, ''), new Blob([entry.data], { type: 'image/jpeg' }));
      } else if (entry.name.indexOf('thumbs/') === 0) {
        thumbs.set(baseName(entry.name).replace(/\.jpg$/i, ''), new Blob([entry.data], { type: 'image/jpeg' }));
      }
    }
    if (!bundle) throw new Error('压缩包里没有找到 backup.json');
    return { bundle: bundle, blobs: blobs, thumbs: thumbs };
  }

  async function applyImport(bundle, mode, blobs, thumbs) {
    if (!bundle || (!Array.isArray(bundle.days) && !bundle.settings)) {
      throw new Error('备份内容无法识别');
    }
    const localIds = new Set((await DB.allPhotos()).map(function (p) { return p.id; }));
    const metaById = new Map();
    (bundle.photos || []).forEach(function (meta) {
      if (meta && meta.id) metaById.set(meta.id, meta);
    });

    const days = (bundle.days || []).map(function (raw) {
      const day = normalizeDay(raw);
      MEAL_DEFS.forEach(function (def) {
        const meal = day.meals[def.key];
        meal.photos = meal.photos.filter(function (id) {
          return blobs.has(id) || localIds.has(id);
        });
      });
      return day;
    });

    const photos = [];
    blobs.forEach(function (blob, id) {
      const meta = metaById.get(id) || {};
      photos.push({
        id: id,
        date: meta.date || '',
        mealKey: meta.mealKey || '',
        blob: blob,
        thumb: thumbs.get(id) || blob,
        width: meta.width || 0,
        height: meta.height || 0,
        size: blob.size,
        createdAt: meta.createdAt || Date.now()
      });
    });

    await DB.importBundle(days, photos, mode === 'replace');
    if (mode === 'replace' && bundle.settings) {
      await DB.putSettings(Object.assign({}, DEFAULT_SETTINGS, bundle.settings, { key: 'app' }));
    }
    return { days: days.length, photos: photos.length };
  }

  async function runImport() {
    const input = $('import-file');
    const file = input.files && input.files[0];
    if (!file) { toast('先选择一个备份文件'); return; }
    const button = $('import-run');
    button.disabled = true;
    button.textContent = '正在导入…';
    try {
      const parsed = await readBackupFile(file);
      const result = await applyImport(parsed.bundle, state.importMode, parsed.blobs, parsed.thumbs);
      state.photoCache = new Map();
      state.photoUrls.forEach(function (url) { URL.revokeObjectURL(url); });
      state.photoUrls = new Map();
      await loadStore();
      applyTheme(state.settings.theme);
      await openDate(todayKey());
      renderTrend();
      renderGoal();
      renderData();
      toast('已导入 ' + result.days + ' 天记录、' + result.photos + ' 张照片');
      input.value = '';
    } catch (err) {
      toast('导入失败：' + (err && err.message ? err.message : '文件无法读取'));
    } finally {
      button.disabled = false;
      button.textContent = '开始导入';
    }
  }

  function exportIcs() {
    const weekday = Number(state.settings.weekMeasureDay);
    const text = buildIcs({
      weekday: Number.isFinite(weekday) ? weekday : 6,
      time: '09:00',
      summary: '测量三围并记录',
      description: '胸围 / 腰围 / 臀围，固定条件下测量更可靠。'
    });
    downloadBlob(new Blob([text], { type: 'text/calendar;charset=utf-8' }), '三围周提醒.ics');
    toast('已生成日历提醒');
  }

  function renderData() {
    $('app-version').textContent = 'v' + APP_VERSION;
    refreshStorageInfo();
    const seg = $('theme-seg').querySelectorAll('button');
    seg.forEach(function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-theme') === state.settings.theme);
    });
    const modes = $('import-mode').querySelectorAll('button');
    modes.forEach(function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-mode') === state.importMode);
    });
    $('install-btn').hidden = !state.installEvent;
  }

  /* =========================================================
     事件绑定与启动
     ========================================================= */

  const saveSettingsDebounced = debounce(function () {
    DB.putSettings(state.settings).then(function () {
      toast('设置已保存');
    }).catch(function (err) {
      toast('设置保存失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }, 500);

  function bindNumberField(input, onChange, after) {
    input.addEventListener('input', function () {
      onChange(parseNum(input.value));
      if (after) after();
    });
    input.addEventListener('change', function () {
      const value = parseNum(input.value);
      input.value = value === null ? '' : String(round1(value));
      onChange(value);
      if (after) after();
    });
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-tab')); });
    });
  }

  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.view').forEach(function (view) {
      view.classList.toggle('is-active', view.getAttribute('data-view') === name);
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('is-on', tab.getAttribute('data-tab') === name);
    });
    if (name === 'trend') renderTrend();
    if (name === 'goal') renderGoal();
    if (name === 'data') renderData();
  }

  function bindDayBar() {
    $('day-prev').addEventListener('click', function () { openDate(addDays(state.date, -1)); });
    $('day-next').addEventListener('click', function () {
      const next = addDays(state.date, 1);
      if (diffDays(next, todayKey()) > 0) return;
      openDate(next);
    });
    $('day-label').addEventListener('click', function () {
      const picker = $('day-picker');
      if (typeof picker.showPicker === 'function') {
        try { picker.showPicker(); return; } catch (err) { /* 退回点击 */ }
      }
      picker.click();
    });
    $('day-picker').addEventListener('change', function () {
      const value = $('day-picker').value;
      if (value) openDate(value > todayKey() ? todayKey() : value);
    });
    $('day-chips').querySelectorAll('[data-jump]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        openDate(addDays(todayKey(), Number(chip.getAttribute('data-jump'))));
      });
    });
    $('day-chips').querySelector('[data-pick]').addEventListener('click', function () {
      const picker = $('day-picker');
      if (typeof picker.showPicker === 'function') {
        try { picker.showPicker(); return; } catch (err) { /* 退回点击 */ }
      }
      picker.click();
    });
  }

  function bindWeightInputs() {
    ['morning', 'noon', 'evening'].forEach(function (metric) {
      const input = $('w-' + metric);
      input.addEventListener('input', function () {
        const value = parseNum(input.value);
        state.day.weights[metric] = value === null ? null : round1(value);
        if (metric === 'morning') updateWeightNote();
        scheduleSave();
      });
      input.addEventListener('change', function () {
        const value = parseNum(input.value);
        state.day.weights[metric] = value === null ? null : round1(value);
        input.value = value === null ? '' : String(round1(value));
        if (metric === 'morning') updateWeightNote();
        scheduleSave();
      });
    });
  }

  function bindMeasureInputs() {
    MEASURE_DEFS.forEach(function (def) {
      const input = $('m-' + def.key);
      input.addEventListener('input', function () {
        const value = parseNum(input.value);
        state.day.measurements[def.key] = value === null ? null : round1(value);
        scheduleSave();
      });
      input.addEventListener('change', function () {
        const value = parseNum(input.value);
        state.day.measurements[def.key] = value === null ? null : round1(value);
        input.value = value === null ? '' : String(round1(value));
        scheduleSave();
      });
    });
    $('measure-toggle').addEventListener('click', function () {
      state.measureOpen = $('measure-body').hidden;
      renderMeasureFields();
    });
  }

  function bindExerciseButtons() {
    $('add-exercise').addEventListener('click', function () {
      state.day.exercises.push(blankExercise());
      scheduleSave();
      renderExercises();
      const rows = $('exercise-list').querySelectorAll('.ex-row');
      const last = rows[rows.length - 1];
      if (last) {
        const select = last.querySelector('select');
        if (select) select.focus();
      }
    });
  }

  function bindNotes() {
    $('day-note').addEventListener('input', function () {
      state.day.note = $('day-note').value;
      scheduleSave();
    });
  }

  function bindSegments() {
    $('range-seg').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const value = btn.getAttribute('data-range');
        state.range = value === 'all' ? 'all' : Number(value);
        $('range-seg').querySelectorAll('button').forEach(function (other) { other.classList.toggle('is-on', other === btn); });
        renderTrend();
      });
    });
    $('metric-seg').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.metric = btn.getAttribute('data-metric');
        $('metric-seg').querySelectorAll('button').forEach(function (other) { other.classList.toggle('is-on', other === btn); });
        renderTrend();
      });
    });
    $('theme-seg').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.settings.theme = btn.getAttribute('data-theme');
        applyTheme(state.settings.theme);
        renderData();
        saveSettingsDebounced();
      });
    });
    $('import-mode').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.importMode = btn.getAttribute('data-mode');
        $('import-hint').textContent = state.importMode === 'merge'
          ? '合并时同一天以导入文件为准，照片按编号去重，本机目标设置保留。'
          : '覆盖时先清空本机全部记录，再用备份文件替换，目标设置也会一起恢复。';
        renderData();
      });
    });
  }

  function bindGoalFields() {
    const after = function () { saveSettingsDebounced(); renderGoal(); };
    bindNumberField($('g-height'), function (v) { state.settings.heightCm = v; }, after);
    bindNumberField($('g-start'), function (v) { state.settings.startWeight = v; }, after);
    bindNumberField($('g-target'), function (v) { state.settings.targetWeight = v; }, after);
    $('g-date').addEventListener('change', function () {
      state.settings.targetDate = $('g-date').value || '';
      after();
    });
    $('g-weekday').addEventListener('change', function () {
      state.settings.weekMeasureDay = Number($('g-weekday').value);
      after();
    });
  }

  function bindDataActions() {
    $('export-json').addEventListener('click', exportJson);
    $('export-zip').addEventListener('click', function () {
      $('export-zip').disabled = true;
      exportZip().catch(function (err) {
        toast('导出失败：' + (err && err.message ? err.message : '未知错误'));
      }).finally(function () { $('export-zip').disabled = false; });
    });
    $('export-ics').addEventListener('click', exportIcs);
    $('import-run').addEventListener('click', runImport);
    $('wipe').addEventListener('click', wipe);
    $('install-btn').addEventListener('click', function () {
      const event = state.installEvent;
      if (!event) return;
      event.prompt();
      state.installEvent = null;
      renderData();
    });
  }

  function bindLightbox() {
    $('lightbox-close').addEventListener('click', closeLightbox);
    $('lightbox').addEventListener('click', function (event) {
      if (event.target === $('lightbox')) closeLightbox();
    });
    $('lightbox-delete').addEventListener('click', function () {
      const id = $('lightbox-delete').getAttribute('data-photo');
      if (id) deletePhoto(id);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('lightbox').hidden) closeLightbox();
    });
  }

  function bindPageLifecycle() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushPending();
    });
    window.addEventListener('pagehide', function () { flushPending(); });
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.installEvent = event;
      if (state.activeTab === 'data') renderData();
    });
    window.addEventListener('appinstalled', function () {
      state.installEvent = null;
      toast('已添加到主屏幕');
      if (state.activeTab === 'data') renderData();
    });
  }

  async function wipe() {
    if (!window.confirm('确定要清空本机全部数据吗？此操作不可撤销。')) return;
    if (!window.confirm('再次确认：所有体重、三围、三餐、运动和照片都会被删除。')) return;
    try {
      await DB.clearAll();
    } catch (err) {
      toast('清空失败：' + (err && err.message ? err.message : '未知错误'));
      return;
    }
    state.days = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    state.photoUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.photoUrls = new Map();
    state.photoCache = new Map();
    applyTheme('auto');
    await openDate(todayKey());
    renderTrend();
    renderGoal();
    renderData();
    toast('已清空本机数据');
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker.register('./sw.js').catch(function () { /* 离线能力不可用，不影响使用 */ });
  }

  async function boot() {
    applyTheme('auto');
    registerServiceWorker();
    try {
      await loadStore();
    } catch (err) {
      toast('无法读取本机数据：' + (err && err.message ? err.message : '未知错误'));
    }
    applyTheme(state.settings.theme);
    bindTabs();
    bindDayBar();
    bindWeightInputs();
    bindMeasureInputs();
    bindExerciseButtons();
    bindNotes();
    bindSegments();
    bindGoalFields();
    bindDataActions();
    bindLightbox();
    bindPageLifecycle();
    await openDate(todayKey());
    renderTrend();
    renderGoal();
    renderData();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
