const express = require('express');

const API = (process.env.NCM_API_BASE || '').replace(/\/+$/, '');
const COOKIE = process.env.NCM_COOKIE || '';
const PARTNER = process.env.NCM_PARTNER_UID || '';
const PORT = process.env.PORT || 10000;
const POLL_MS = 20 * 1000;
const TIMEOUT_MS = 60000;

const state = {
  roomId: null,
  inviterId: null,
  song: null,
  joinedAt: null,
  lastError: null,
  lastTickAt: null,
  tickCount: 0,
  busy: false,
  history: []
};

function errText(e) {
  if (!e) return 'unknown';
  let s = (e.name || 'Error') + ': ' + (e.message || String(e));
  if (e.cause) s += ' | cause: ' + (e.cause.code || '') + ' ' + (e.cause.message || '');
  return s;
}

async function call(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (COOKIE) url.searchParams.set('cookie', COOKIE);

  let r;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': 'ncm-listen-mcp/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw new Error(errText(e) + ' ｜ 请求 ' + path);
  }

  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data) {
    throw new Error('返回的不是 JSON，HTTP ' + r.status + ' ｜ 请求 ' + path + ' ｜ 前 120 字：' + text.slice(0, 120));
  }
  return { status: r.status, data: data, text: text };
}

function decodeAll(s) {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    let next = cur;
    try { next = decodeURIComponent(cur); } catch (e) { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function parseInvite(raw) {
  if (typeof raw !== 'string') return null;
  const s = decodeAll(raw);
  const room = s.match(/roomId=(\d+)/i);
  const inv = s.match(/inviterId=(\d+)/i);
  if (!room || !inv) return null;
  return { roomId: room[1], inviterId: inv[1] };
}

function scanInvite(node) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') {
    const p = parseInvite(node);
    if (p) return p;
    const dec = decodeAll(node);
    const t = dec.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return scanInvite(JSON.parse(t)); } catch (e) { return null; }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const p = scanInvite(item);
      if (p) return p;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const p = scanInvite(v);
      if (p) return p;
    }
  }
  return null;
}

async function findInvite() {
  const res = await call('/msg/private/history', { uid: PARTNER, limit: 10 });
  const data = res.data || {};
  if (data.code && data.code !== 200) {
    throw new Error('查私信返回 code=' + data.code + ' msg=' + (data.message || data.msg || ''));
  }
  const list = data.msgs || data.records || (data.data && data.data.msgs) || [];
  const items = Array.isArray(list) ? list : [];
  for (const item of items) {
    const inv = scanInvite(item);
    if (inv) return inv;
  }
  return null;
}

async function refreshSong() {
  if (!state.roomId) return;
  const res = await call('/listentogether/sync/playlist/get', { roomId: state.roomId });
  const data = (res.data && res.data.data) || {};
  const list = data.playlist || data.songList || [];
  if (!Array.isArray(list) || list.length === 0) return;

  let current = null;
  for (const item of list) {
    if (item && (item.playing === true || item.playStatus === 1)) { current = item; break; }
  }
  if (!current) current = list[0];

  let songId = current.songId || current.id || (current.song && current.song.id);
  if (!songId) return;
  songId = String(songId);

  if (state.song && state.song.id === songId) return;

  let name = (current.song && current.song.name) || current.name || songId;
  let artist = '';
  let album = '';

  try {
    const det = await call('/song/detail', { ids: songId });
    const song = det.data && det.data.songs && det.data.songs[0];
    if (song) {
      name = song.name || name;
      artist = (song.ar || song.artists || []).map(function (a) { return a.name; }).join('/');
      album = (song.al && song.al.name) || (song.album && song.album.name) || '';
    }
  } catch (e) {
    state.lastError = errText(e);
  }

  state.song = { id: songId, name: name, artist: artist, album: album, at: Date.now() };
  state.history.unshift({ name: name, artist: artist, at: Date.now() });
  if (state.history.length > 20) state.history.length = 20;
}

async function tickOnce() {
  if (!API || !COOKIE || !PARTNER) {
    state.lastError = '环境变量不全：API=' + (API ? '有' : '空') + ' COOKIE=' + (COOKIE ? '有' : '空') + ' PARTNER=' + (PARTNER ? '有' : '空');
    return;
  }

  if (!state.roomId) {
    const inv = await findInvite();
    if (!inv) {
      state.lastError = null;
      return;
    }
    const acc = await call('/listentogether/accept', { roomId: inv.roomId, inviterId: inv.inviterId });
    const code = acc.data && acc.data.code;
    if (code === 200) {
      state.roomId = inv.roomId;
      state.inviterId = inv.inviterId;
      state.joinedAt = Date.now();
      state.lastError = null;
      await refreshSong();
    } else {
      state.lastError = '接受邀请失败 code=' + code + ' ' + JSON.stringify(acc.data).slice(0, 200);
    }
    return;
  }

  const songId = state.song ? state.song.id : '0';
  const beat = await call('/listentogether/heatbeat', {
    roomId: state.roomId,
    songId: songId,
    playStatus: 'true',
    progress: 0
  });

  const beatCode = beat.data && beat.data.code;
  if (beat.status === 488 || beatCode === 488) {
    state.roomId = null;
    state.inviterId = null;
    state.song = null;
    state.joinedAt = null;
    return;
  }

  await refreshSong();
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  state.lastTickAt = Date.now();
  state.tickCount = state.tickCount + 1;
  try {
    await tickOnce();
  } catch (e) {
    state.lastError = errText(e);
  } finally {
    state.busy = false;
  }
}

function stateText() {
  const head = '第 ' + state.tickCount + ' 轮检查，上次 ' + (state.lastTickAt ? new Date(state.lastTickAt).toLocaleString('zh-CN') : '还没跑');
  const err = state.lastError ? '最近一次异常：' + state.lastError : '最近没有异常';

  if (!state.roomId) {
    return head + '\n现在不在房间里\n' + err;
  }
  if (!state.song) {
    return head + '\n已经在房间里，还没读到正在放什么\n' + err;
  }
  const mins = Math.max(0, Math.round((Date.now() - state.song.at) / 60000));
  return head + '\n在房间里\n正在放：' + state.song.name + (state.song.artist ? ' - ' + state.song.artist : '') + (state.song.album ? '（《' + state.song.album + '》）' : '') + '\n这首歌是 ' + mins + ' 分钟前换上的';
}

async function runTool(name, args) {
  if (name === 'now_playing') return stateText();

  if (name === 'recent_songs') {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
    if (!state.history.length) return '这次一起听还没有歌。';
    return state.history.slice(0, limit).map(function (s, i) {
      return (i + 1) + '. ' + s.name + (s.artist ? ' - ' + s.artist : '');
    }).join('\n');
  }

  if (name === 'search_song') {
    const kw = String(args.keywords || '').trim();
    if (!kw) return '没给关键词。';
    const res = await call('/search', { keywords: kw, limit: 5 });
    const songs = (res.data && res.data.result && res.data.result.songs) || [];
    if (!songs.length) return '没搜到：' + kw;
    return songs.map(function (s, i) {
      const ar = (s.ar || s.artists || []).map(function (a) { return a.name; }).join('/');
      return (i + 1) + '. ' + s.name + ' - ' + ar + '（id ' + s.id + '）';
    }).join('\n');
  }

  if (name === 'song_lyric') {
    const id = String(args.id || '').trim();
    if (!id) return '没给歌曲 id。';
    const res = await call('/lyric', { id: id });
    const lrc = (res.data && res.data.lrc && res.data.lrc.lyric) || '';
    if (!lrc) return '这首歌没有歌词，或者授权不到。';
    return lrc.slice(0, 4000);
  }

  return '没有这个工具：' + name;
}

const TOOLS = [
  {
    name: 'now_playing',
    description: '查询网易云一起听房间现在在放哪首歌，以及是否已经在房间里。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'recent_songs',
    description: '返回这次一起听里最近播放过的歌，按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回几条，默认 10' } },
      additionalProperties: false
    }
  },
  {
    name: 'search_song',
    description: '在网易云搜索歌曲，返回歌名、歌手和歌曲 id。',
    inputSchema: {
      type: 'object',
      properties: { keywords: { type: 'string', description: '搜索关键词' } },
      required: ['keywords'],
      additionalProperties: false
    }
  },
  {
    name: 'song_lyric',
    description: '按歌曲 id 读取歌词。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '歌曲 id' } },
      required: ['id'],
      additionalProperties: false
    }
  }
];

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', function (req, res) {
  res.type('text/plain').send('ncm-listen-mcp 活着\n' + stateText());
});

app.get('/debug', async function (req, res) {
  const out = { api: API, partner: PARTNER, hasCookie: !!COOKIE, tickCount: state.tickCount };
  try {
    const r = await call('/msg/private/history', { uid: PARTNER, limit: 3 });
    out.probeStatus = r.status;
    out.probeCode = r.data && r.data.code;
    out.probeHead = JSON.stringify(r.data).slice(0, 300);
  } catch (e) {
    out.probeError = errText(e);
  }
  res.type('text/plain').send(JSON.stringify(out, null, 2));
});

app.post('/mcp', async function (req, res) {
  const msg = req.body;
  if (!msg || typeof msg !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  const reply = function (result) { res.json({ jsonrpc: '2.0', id: id, result: result }); };
  const fail = function (code, message) { res.json({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); };

  if (method === 'initialize') {
    res.setHeader('Mcp-Session-Id', 'ncm-' + Math.random().toString(36).slice(2, 12));
    return reply({
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ncm-listen-mcp', version: '1.0.2' }
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') {
    return res.status(202).end();
  }

  if (method === 'ping') return reply({});

  if (method === 'tools/list') return reply({ tools: TOOLS });

  if (method === 'tools/call') {
    try {
      const text = await runTool(params.name, params.arguments || {});
      return reply({ content: [{ type: 'text', text: text }] });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: '出错：' + errText(e) }], isError: true });
    }
  }

  return fail(-32601, 'Method not found: ' + method);
});

app.get('/mcp', function (req, res) {
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'SSE 流没开，用 POST' } });
});

app.listen(PORT, function () {
  console.log('listening on ' + PORT + ' api=' + API + ' partner=' + PARTNER);
  tick();
  setInterval(tick, POLL_MS);
});
