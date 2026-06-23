/**
 * MusiCloud — app.js
 * Main application logic: IndexedDB, player engine, UI rendering, Media Session.
 *
 * Architecture:
 *  DB         — IndexedDB wrapper (songs, playlists, history, settings)
 *  Player     — Audio engine + MediaSession API
 *  UI         — View rendering, event binding, navigation
 *  App        — Top-level init, wiring
 *
 * iOS Notes (see also index.html):
 *  • We use a single <audio> element (never create new ones per track).
 *  • After first user-gesture play, iOS unlocks the audio session. We track
 *    this with `audioUnlocked` and gate autoplay through it.
 *  • The MediaSession API is used to register handlers for lock-screen controls.
 *  • Auto-advance on track end is handled in the 'ended' event, which fires
 *    reliably on iOS when using a persistent <audio> element + MediaSession.
 *  • We do NOT try to keep a silent audio loop alive — MediaSession is enough
 *    in iOS 16.4+ (required for PWA install anyway).
 */

/* ═══════════════════════════════════════════════════════════════
   DATABASE MODULE
════════════════════════════════════════════════════════════════ */
const DB = (() => {
  const DB_NAME = 'MusiCloud';
  const DB_VER  = 1;
  let db;

  /** Open (or upgrade) the IndexedDB database */
  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);

      req.onupgradeneeded = e => {
        const d = e.target.result;

        // songs_meta: song metadata records
        if (!d.objectStoreNames.contains('songs_meta')) {
          const s = d.createObjectStore('songs_meta', { keyPath: 'id' });
          s.createIndex('artist', 'artist', { unique: false });
          s.createIndex('album', 'album', { unique: false });
          s.createIndex('dateAdded', 'dateAdded', { unique: false });
        }

        // songs_audio: raw ArrayBuffer blobs, keyed by song id
        if (!d.objectStoreNames.contains('songs_audio')) {
          d.createObjectStore('songs_audio', { keyPath: 'id' });
        }

        // playlists: { id, name, songIds[], dateCreated }
        if (!d.objectStoreNames.contains('playlists')) {
          d.createObjectStore('playlists', { keyPath: 'id' });
        }

        // history: { id (timestamp), songId, playedAt, durationMs }
        if (!d.objectStoreNames.contains('history')) {
          const h = d.createObjectStore('history', { keyPath: 'id' });
          h.createIndex('songId', 'songId', { unique: false });
          h.createIndex('playedAt', 'playedAt', { unique: false });
        }

        // settings: key-value store
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  /** Generic transaction helper */
  async function tx(stores, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      t.onerror = e => reject(e.target.error);
      resolve(fn(t));
    });
  }

  /** Wrap an IDBRequest in a Promise */
  const wrap = req => new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });

  /* ── SONGS ── */
  const Songs = {
    async add(meta, audioBuffer) {
      return tx(['songs_meta', 'songs_audio'], 'readwrite', t => {
        const p1 = wrap(t.objectStore('songs_meta').put(meta));
        const p2 = wrap(t.objectStore('songs_audio').put({ id: meta.id, data: audioBuffer }));
        return Promise.all([p1, p2]);
      });
    },

    async getAllMeta() {
      return tx(['songs_meta'], 'readonly', t =>
        wrap(t.objectStore('songs_meta').getAll())
      );
    },

    async getMeta(id) {
      return tx(['songs_meta'], 'readonly', t =>
        wrap(t.objectStore('songs_meta').get(id))
      );
    },

    async updateMeta(meta) {
      return tx(['songs_meta'], 'readwrite', t =>
        wrap(t.objectStore('songs_meta').put(meta))
      );
    },

    async getAudio(id) {
      const rec = await tx(['songs_audio'], 'readonly', t =>
        wrap(t.objectStore('songs_audio').get(id))
      );
      return rec ? rec.data : null;
    },

    async delete(id) {
      return tx(['songs_meta', 'songs_audio'], 'readwrite', t => {
        const p1 = wrap(t.objectStore('songs_meta').delete(id));
        const p2 = wrap(t.objectStore('songs_audio').delete(id));
        return Promise.all([p1, p2]);
      });
    }
  };

  /* ── PLAYLISTS ── */
  const Playlists = {
    async getAll() {
      return tx(['playlists'], 'readonly', t =>
        wrap(t.objectStore('playlists').getAll())
      );
    },
    async get(id) {
      return tx(['playlists'], 'readonly', t =>
        wrap(t.objectStore('playlists').get(id))
      );
    },
    async save(pl) {
      return tx(['playlists'], 'readwrite', t =>
        wrap(t.objectStore('playlists').put(pl))
      );
    },
    async delete(id) {
      return tx(['playlists'], 'readwrite', t =>
        wrap(t.objectStore('playlists').delete(id))
      );
    }
  };

  /* ── HISTORY ── */
  const History = {
    async add(songId, durationMs) {
      const rec = { id: `${Date.now()}-${Math.random()}`, songId, playedAt: Date.now(), durationMs };
      return tx(['history'], 'readwrite', t =>
        wrap(t.objectStore('history').add(rec))
      );
    },
    async getAll() {
      return tx(['history'], 'readonly', t =>
        wrap(t.objectStore('history').getAll())
      );
    }
  };

  /* ── SETTINGS ── */
  const Settings = {
    async get(key, fallback = null) {
      const rec = await tx(['settings'], 'readonly', t =>
        wrap(t.objectStore('settings').get(key))
      );
      return rec ? rec.value : fallback;
    },
    async set(key, value) {
      return tx(['settings'], 'readwrite', t =>
        wrap(t.objectStore('settings').put({ key, value }))
      );
    }
  };

  return { open, Songs, Playlists, History, Settings };
})();


/* ═══════════════════════════════════════════════════════════════
   PLAYER ENGINE
════════════════════════════════════════════════════════════════ */
const Player = (() => {
  const audio = document.getElementById('audio-player');
  let currentObjectURL = null;  // We revoke old URLs to prevent memory leaks

  const state = {
    queue:        [],    // ordered list of song ids
    queueIndex:   -1,   // current position in queue
    shuffle:      false,
    repeat:       'none', // 'none' | 'all' | 'one'
    isPlaying:    false,
    volume:       1.0,
    currentSong:  null,  // full meta object
    audioUnlocked: false,
    playbackStart: null, // timestamp when current track started playing (for history)
    playbackMs:    0,    // accumulated ms for current track
  };

  // Callbacks for UI updates
  const listeners = {
    onTrackChange: null,
    onPlayState:   null,
    onProgress:    null,
    onQueueChange: null,
  };

  function on(event, fn) { listeners[event] = fn; }

  /* ── Load & play a song by id ── */
  async function playSong(songId, { addToHistory = true } = {}) {
    const meta = await DB.Songs.getMeta(songId);
    if (!meta) return;

    // Record how long we listened to the previous track
    if (state.currentSong && state.playbackStart) {
      _recordHistory();
    }

    state.currentSong = meta;
    state.playbackStart = Date.now();

    // Revoke previous object URL to free memory
    if (currentObjectURL) {
      URL.revokeObjectURL(currentObjectURL);
      currentObjectURL = null;
    }

    // Load audio data from IndexedDB into a Blob URL
    const audioData = await DB.Songs.getAudio(songId);
    if (!audioData) { console.warn('No audio data for', songId); return; }

    const blob = new Blob([audioData], { type: 'audio/mpeg' });
    currentObjectURL = URL.createObjectURL(blob);

    audio.src = currentObjectURL;
    audio.volume = state.volume;

    // iOS: play() returns a promise; we must handle its rejection gracefully
    try {
      await audio.play();
      state.isPlaying = true;
      state.audioUnlocked = true;
    } catch (err) {
      // NotAllowedError on iOS before user gesture — UI shows paused state
      console.warn('Audio play() blocked (no user gesture yet):', err.name);
      state.isPlaying = false;
    }

    listeners.onTrackChange?.(state.currentSong);
    listeners.onPlayState?.(state.isPlaying);
    _updateMediaSession();
  }

  /* ── Play/Pause toggle ── */
  async function togglePlay() {
    if (!state.currentSong) return;
    if (state.isPlaying) {
      audio.pause();
      state.isPlaying = false;
      _recordHistory(); // partial listen
    } else {
      try {
        await audio.play();
        state.isPlaying = true;
        state.audioUnlocked = true;
        state.playbackStart = Date.now();
      } catch(e) {
        console.warn('Play blocked:', e);
      }
    }
    listeners.onPlayState?.(state.isPlaying);
    _updateMediaSession();
  }

  /* ── Skip next / previous ── */
  async function next() {
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(()=>{});
      return;
    }
    let nextIndex;
    if (state.shuffle) {
      nextIndex = Math.floor(Math.random() * state.queue.length);
    } else {
      nextIndex = state.queueIndex + 1;
      if (nextIndex >= state.queue.length) {
        if (state.repeat === 'all') {
          nextIndex = 0;
        } else {
          // End of queue — stop playback
          state.isPlaying = false;
          state.queueIndex = state.queue.length - 1;
          listeners.onPlayState?.(false);
          return;
        }
      }
    }
    state.queueIndex = nextIndex;
    await playSong(state.queue[nextIndex]);
    listeners.onQueueChange?.();
  }

  async function prev() {
    // If more than 3 seconds in, restart current track
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prevIndex = state.queueIndex - 1;
    if (prevIndex < 0) prevIndex = state.shuffle ? Math.floor(Math.random() * state.queue.length) : 0;
    state.queueIndex = prevIndex;
    await playSong(state.queue[prevIndex]);
    listeners.onQueueChange?.();
  }

  /* ── Set a new queue and play from an index ── */
  async function setQueue(songIds, startIndex = 0) {
    state.queue = [...songIds];
    state.queueIndex = startIndex;
    await playSong(songIds[startIndex]);
    listeners.onQueueChange?.();
  }

  /* ── Add to queue ── */
  function addToQueue(songId) {
    state.queue.push(songId);
    listeners.onQueueChange?.();
  }

  /* ── Play next (insert after current) ── */
  function playNext(songId) {
    state.queue.splice(state.queueIndex + 1, 0, songId);
    listeners.onQueueChange?.();
  }

  /* ── Shuffle toggle ── */
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    return state.shuffle;
  }

  /* ── Repeat cycle: none → all → one → none ── */
  function cycleRepeat() {
    const modes = ['none', 'all', 'one'];
    const i = modes.indexOf(state.repeat);
    state.repeat = modes[(i + 1) % modes.length];
    return state.repeat;
  }

  /* ── Seek ── */
  function seek(fraction) {
    if (!isNaN(audio.duration)) {
      audio.currentTime = fraction * audio.duration;
    }
  }

  /* ── Volume ── */
  function setVolume(v) {
    state.volume = v;
    audio.volume = v;
  }

  /* ── Getters ── */
  function getProgress() {
    if (!audio.duration || isNaN(audio.duration)) return 0;
    return audio.currentTime / audio.duration;
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }

  /* ── Record partial/full listen to history ── */
  function _recordHistory() {
    if (!state.currentSong || !state.playbackStart) return;
    const elapsed = Date.now() - state.playbackStart;
    state.playbackMs += elapsed;
    state.playbackStart = null;

    // Only count if at least 10 seconds listened
    if (state.playbackMs > 10000) {
      DB.History.add(state.currentSong.id, state.playbackMs).catch(()=>{});
      // Increment play count on meta
      DB.Songs.getMeta(state.currentSong.id).then(meta => {
        if (meta) {
          meta.playCount = (meta.playCount || 0) + 1;
          meta.lastPlayed = Date.now();
          DB.Songs.updateMeta(meta);
        }
      });
    }
    state.playbackMs = 0;
  }

  /* ── Media Session API (lock screen controls) ── */
  function _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = state.currentSong;
    if (!s) return;

    const artwork = s.artDataUrl
      ? [{ src: s.artDataUrl, sizes: '512x512', type: 'image/jpeg' }]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title:  s.title  || 'Unknown Title',
      artist: s.artist || 'Unknown Artist',
      album:  s.album  || '',
      artwork
    });

    navigator.mediaSession.setActionHandler('play',           () => { audio.play(); state.isPlaying = true; listeners.onPlayState?.(true); });
    navigator.mediaSession.setActionHandler('pause',          () => { audio.pause(); state.isPlaying = false; listeners.onPlayState?.(false); });
    navigator.mediaSession.setActionHandler('nexttrack',      () => next());
    navigator.mediaSession.setActionHandler('previoustrack',  () => prev());
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d.seekTime !== undefined && !isNaN(audio.duration)) {
        audio.currentTime = d.seekTime;
      }
    });

    // iOS 17+ supports this for smoother lock-screen scrubbing
    try {
      navigator.mediaSession.setActionHandler('seekbackward', d => {
        audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', d => {
        audio.currentTime = Math.min(audio.duration, audio.currentTime + (d.seekOffset || 10));
      });
    } catch(e) {}
  }

  /* ── Audio element event listeners ── */
  audio.addEventListener('timeupdate', () => {
    listeners.onProgress?.({
      currentTime: audio.currentTime,
      duration: audio.duration,
      progress: getProgress(),
    });
  });

  audio.addEventListener('ended', () => {
    /*
     * iOS Safari PWA — CRITICAL:
     * The 'ended' event fires on the locked screen when using a single persistent
     * <audio> element with MediaSession registered. We call next() here to
     * auto-advance without requiring the user to reopen the app.
     *
     * If you experience tracks not advancing on iOS:
     * 1. Confirm the MediaSession handlers above are registered (requires HTTPS).
     * 2. Make sure you're not creating new Audio() objects per track.
     * 3. iOS 16.3 and earlier have stricter background limits — test on 16.4+.
     */
    _recordHistory();
    next();
  });

  audio.addEventListener('pause', () => {
    if (!audio.ended) {
      state.isPlaying = false;
      listeners.onPlayState?.(false);
      if (state.playbackStart) {
        state.playbackMs += Date.now() - state.playbackStart;
        state.playbackStart = null;
      }
    }
  });

  audio.addEventListener('play', () => {
    state.isPlaying = true;
    state.playbackStart = Date.now();
    listeners.onPlayState?.(true);
  });

  audio.addEventListener('error', e => {
    console.error('Audio error:', e);
  });

  return {
    state, on,
    playSong, togglePlay, next, prev, setQueue,
    addToQueue, playNext, toggleShuffle, cycleRepeat,
    seek, setVolume, getProgress, formatTime,
  };
})();


/* ═══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
════════════════════════════════════════════════════════════════ */

/** Generate a simple unique ID */
function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Show a brief toast notification */
function toast(msg, duration = 2800) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), duration + 200);
}

/** Parse ID3 tags from a File/Blob using jsmediatags */
function parseID3(file) {
  return new Promise(resolve => {
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => resolve(tags),
      onError:   ()         => resolve({})
    });
  });
}

/** Convert ID3 picture data to a data URL */
function pictureToDataUrl(picture) {
  if (!picture) return null;
  try {
    const { data, format } = picture;
    const u8 = new Uint8Array(data);
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return `data:${format};base64,${btoa(bin)}`;
  } catch { return null; }
}

/** Read a File as ArrayBuffer */
function readFileAsBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

/** Format milliseconds to "X h Y m" */
function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Get greeting based on time of day */
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

/** Sanitize filename as fallback title */
function filenameToTitle(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Create a song metadata record from file + tags */
async function buildSongMeta(file, tags) {
  const duration = await getAudioDuration(file);
  return {
    id:         uid(),
    title:      tags.title  || filenameToTitle(file.name),
    artist:     tags.artist || 'Unknown Artist',
    album:      tags.album  || 'Unknown Album',
    track:      tags.track  || null,
    year:       tags.year   || null,
    artDataUrl: pictureToDataUrl(tags.picture),
    duration,
    playCount:  0,
    favorite:   false,
    lastPlayed: null,
    dateAdded:  Date.now(),
  };
}

/** Get audio duration from a File */
function getAudioDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    a.src = url;
  });
}

/** Create DOM element with optional class and innerHTML */
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** Render album art as <img> or placeholder */
function artEl(artDataUrl, cls = '') {
  if (artDataUrl) {
    const img = document.createElement('img');
    img.src = artDataUrl;
    img.className = cls || 'card-art';
    img.loading = 'lazy';
    img.alt = '';
    return img;
  }
  const div = el('div', cls ? `${cls.replace('card-art','card-art-placeholder')}` : 'card-art-placeholder');
  div.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  return div;
}


/* ═══════════════════════════════════════════════════════════════
   UI MODULE
════════════════════════════════════════════════════════════════ */
const UI = (() => {
  let songs = [];        // all songs (meta)
  let playlists = [];    // all playlists
  let currentPlaylistId = null;
  let currentAlbum = null;
  let currentArtist = null;
  let contextTarget = null; // { songId, playlistId }

  // ── MULTI-SELECT STATE ──
  let selectMode = false;
  const selectedIds = new Set(); // song ids currently checked

  /* ── NAVIGATION ── */
  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === viewName);
    });
    const view = document.getElementById(`view-${viewName}`);
    if (view) {
      view.classList.add('active');
      // Reset detail views when navigating to parent
      if (viewName === 'albums') showAlbumsList();
      if (viewName === 'artists') showArtistsList();
      if (viewName === 'playlists') showPlaylistsList();
    }

    // Lazy render content
    switch (viewName) {
      case 'home':      renderHome(); break;
      case 'songs':     renderSongs(); break;
      case 'albums':    renderAlbums(); break;
      case 'artists':   renderArtists(); break;
      case 'playlists': renderPlaylists(); break;
      case 'favorites': renderFavorites(); break;
      case 'stats':     renderStats(); break;
    }
  }

  /* ── SONG LIST RENDERING ── */
  function renderSongRow(song, { index, allSongs, playlistId } = {}) {
    const row = el('div', 'song-row');
    if (Player.state.currentSong?.id === song.id) row.classList.add('playing');
    if (selectedIds.has(song.id)) row.classList.add('selected');
    row.dataset.songId = song.id;

    // ── Checkbox column (only visible in select mode via CSS) ──
    const checkCol = el('div', 'song-check');
    const circle = el('div', 'song-check-circle');
    circle.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
    checkCol.appendChild(circle);

    // Art
    const artWrap = el('div', 'song-art-wrap');
    artWrap.appendChild(artEl(song.artDataUrl, 'song-art'));
    // Overlay with playing bars
    const overlay = el('div', 'song-art-overlay');
    overlay.innerHTML = `<div class="playing-bars"><span></span><span></span><span></span></div>`;
    artWrap.appendChild(overlay);

    // Meta
    const meta = el('div', 'song-meta');
    const title = el('div', 'song-title', song.title);
    const sub = el('div', 'song-sub', `${song.artist} · ${song.album}`);
    meta.appendChild(title);
    meta.appendChild(sub);

    // Actions
    const actions = el('div', 'song-actions');
    const fav = el('button', `icon-btn fav-btn${song.favorite ? ' active':''}`);
    fav.title = 'Favorite';
    fav.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    fav.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(song.id, fav); });

    const dur = el('span', 'song-duration', Player.formatTime(song.duration));
    const more = el('button', 'icon-btn', `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`);
    more.title = 'More';
    more.addEventListener('click', e => { e.stopPropagation(); showContextMenu(e, song.id, playlistId); });

    actions.appendChild(fav);
    actions.appendChild(dur);
    actions.appendChild(more);

    row.appendChild(checkCol);
    row.appendChild(artWrap);
    row.appendChild(meta);
    row.appendChild(actions);

    // Click handler — behaves differently in select mode vs normal mode
    row.addEventListener('click', (e) => {
      if (selectMode) {
        // Toggle selection
        if (selectedIds.has(song.id)) {
          selectedIds.delete(song.id);
          row.classList.remove('selected');
        } else {
          selectedIds.add(song.id);
          row.classList.add('selected');
        }
        _updateMultiselectBar();
      } else {
        // Normal play behaviour
        const queue = allSongs || songs;
        const idx = queue.findIndex(s => s.id === song.id);
        Player.setQueue(queue.map(s => s.id), idx < 0 ? 0 : idx);
      }
    });

    // Long-press on mobile → enter select mode and select this song
    let longPressTimer;
    row.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => {
        if (!selectMode) enterSelectMode();
        selectedIds.add(song.id);
        row.classList.add('selected');
        _updateMultiselectBar();
      }, 500);
    }, { passive: true });
    row.addEventListener('touchend',   () => clearTimeout(longPressTimer), { passive: true });
    row.addEventListener('touchmove',  () => clearTimeout(longPressTimer), { passive: true });

    return row;
  }

  /* ── MULTI-SELECT HELPERS ── */
  function enterSelectMode() {
    selectMode = true;
    selectedIds.clear();
    document.body.classList.add('select-mode');
    document.getElementById('select-mode-btn').classList.add('active');
    document.getElementById('multiselect-bar').classList.remove('hidden');
    _updateMultiselectBar();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds.clear();
    document.body.classList.remove('select-mode');
    document.getElementById('select-mode-btn').classList.remove('active');
    document.getElementById('multiselect-bar').classList.add('hidden');
    // Deselect all rows
    document.querySelectorAll('.song-row.selected').forEach(r => r.classList.remove('selected'));
  }

  function _updateMultiselectBar() {
    const n = selectedIds.size;
    document.getElementById('multiselect-count').textContent =
      n === 0 ? 'Tap songs to select' : `${n} song${n !== 1 ? 's' : ''} selected`;
  }

  /** Return the currently selected songs in their display order */
  function getSelectedSongs() {
    // Preserve the order they appear in the rendered list
    return songs.filter(s => selectedIds.has(s.id));
  }

  /** Add all currently selected songs to a playlist (picker modal) */
  async function addSelectedToPlaylist() {
    const selected = getSelectedSongs();
    if (!selected.length) { toast('Select at least one song first'); return; }

    let playlistId;
    if (!playlists.length) {
      // No playlists exist — offer to create one on the spot
      const name = await showInputModal('New Playlist', 'Playlist name', 'My Playlist');
      if (!name) return;
      const pl = { id: uid(), name, songIds: [], dateCreated: Date.now() };
      await DB.Playlists.save(pl);
      playlists.push(pl);
      playlistId = pl.id;
      toast(`Playlist "${name}" created`);
    } else {
      // Let user pick existing or create new
      const newOpt = `<option value="__new__">+ Create new playlist…</option>`;
      const opts = playlists.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
      const ok = await showSelectModal('Add to Playlist', `<select id="playlist-select">${newOpt}${opts}</select>`);
      if (!ok) return;
      const val = document.getElementById('playlist-select').value;
      if (val === '__new__') {
        const name = await showInputModal('New Playlist', 'Playlist name', 'My Playlist');
        if (!name) return;
        const pl = { id: uid(), name, songIds: [], dateCreated: Date.now() };
        await DB.Playlists.save(pl);
        playlists.push(pl);
        playlistId = pl.id;
      } else {
        playlistId = val;
      }
    }

    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    let added = 0;
    for (const song of selected) {
      if (!pl.songIds.includes(song.id)) { pl.songIds.push(song.id); added++; }
    }
    await DB.Playlists.save(pl);
    toast(`Added ${added} song${added !== 1 ? 's' : ''} to "${pl.name}"`);
    exitSelectMode();
  }

  /* ── HOME ── */
  function renderHome() {
    document.getElementById('greeting-time').textContent = getGreeting();

    // Recent albums (up to 6 unique)
    const seen = new Set();
    const recents = songs
      .slice().sort((a,b) => b.dateAdded - a.dateAdded)
      .filter(s => { if (seen.has(s.album)) return false; seen.add(s.album); return true; })
      .slice(0, 6);

    const grid = document.getElementById('home-recents');
    grid.innerHTML = '';
    if (!recents.length) { grid.innerHTML = '<p style="color:var(--text3);font-size:.85rem">Upload music to get started</p>'; return; }

    recents.forEach(s => {
      const card = createAlbumCard(s.album, s.artist, s.artDataUrl);
      card.addEventListener('click', () => showAlbumDetail(s.album));
      grid.appendChild(card);
    });

    // Recent songs
    const recentEl = document.getElementById('home-recent-songs');
    recentEl.innerHTML = '';
    songs.slice().sort((a,b) => b.dateAdded - a.dateAdded).slice(0,10).forEach((s, i) => {
      recentEl.appendChild(renderSongRow(s, { index: i }));
    });
  }

  /* ── SONGS ── */
  function renderSongs() {
    const query = document.getElementById('search-input').value.toLowerCase();
    const sort  = document.getElementById('sort-select').value;

    let list = [...songs];
    if (query) list = list.filter(s =>
      s.title.toLowerCase().includes(query) || s.artist.toLowerCase().includes(query)
    );

    list.sort((a,b) => {
      if (sort === 'title')     return a.title.localeCompare(b.title);
      if (sort === 'artist')    return a.artist.localeCompare(b.artist);
      if (sort === 'dateAdded') return b.dateAdded - a.dateAdded;
      if (sort === 'playCount') return (b.playCount||0) - (a.playCount||0);
      return 0;
    });

    const container = document.getElementById('songs-list');
    container.innerHTML = '';

    if (!list.length) {
      container.appendChild(emptyState(query ? 'No results' : 'No songs yet', query ? 'Try a different search.' : 'Go to Settings → Upload Files to add music.'));
      return;
    }

    list.forEach((s, i) => container.appendChild(renderSongRow(s, { index: i, allSongs: list })));
  }

  /* ── ALBUMS ── */
  function renderAlbums() {
    const albums = groupBy(songs, 'album');
    const grid = document.getElementById('albums-grid');
    grid.innerHTML = '';

    if (!Object.keys(albums).length) { grid.appendChild(emptyState('No albums', 'Upload music to see albums.')); return; }

    Object.entries(albums).sort(([a],[b]) => a.localeCompare(b)).forEach(([album, list]) => {
      const card = createAlbumCard(album, list[0].artist, list[0].artDataUrl);
      card.addEventListener('click', () => showAlbumDetail(album));
      grid.appendChild(card);
    });
  }

  function createAlbumCard(album, artist, artDataUrl) {
    const card = el('div', 'card');
    card.appendChild(artEl(artDataUrl));
    const body = el('div', 'card-body');
    body.innerHTML = `<div class="card-title">${escHtml(album)}</div><div class="card-sub">${escHtml(artist)}</div>`;
    card.appendChild(body);
    return card;
  }

  function showAlbumDetail(albumName) {
    currentAlbum = albumName;
    document.getElementById('albums-grid').classList.add('hidden');
    const detail = document.getElementById('album-detail');
    detail.classList.remove('hidden');

    const albumSongs = songs.filter(s => s.album === albumName).sort((a,b) => (a.track||999) - (b.track||999));
    const first = albumSongs[0];

    const header = document.getElementById('album-detail-header');
    header.innerHTML = '';
    header.appendChild(artEl(first?.artDataUrl, 'detail-art'));
    const info = el('div', 'detail-info');
    info.innerHTML = `<h2>${escHtml(albumName)}</h2><p>${escHtml(first?.artist || '')} · ${albumSongs.length} songs</p>`;
    const playBtn = el('button', 'detail-play-btn', '▶ Play Album');
    playBtn.addEventListener('click', () => Player.setQueue(albumSongs.map(s => s.id), 0));
    info.appendChild(playBtn);
    header.appendChild(info);

    const list = document.getElementById('album-detail-songs');
    list.innerHTML = '';
    albumSongs.forEach((s, i) => list.appendChild(renderSongRow(s, { index: i, allSongs: albumSongs })));
  }

  function showAlbumsList() {
    document.getElementById('albums-grid').classList.remove('hidden');
    document.getElementById('album-detail').classList.add('hidden');
  }

  /* ── ARTISTS ── */
  function renderArtists() {
    const artists = groupBy(songs, 'artist');
    const grid = document.getElementById('artists-grid');
    grid.innerHTML = '';

    Object.entries(artists).sort(([a],[b]) => a.localeCompare(b)).forEach(([artist, list]) => {
      const card = el('div', 'card');
      card.appendChild(artEl(list[0].artDataUrl, 'card-art'));
      const body = el('div', 'card-body');
      body.innerHTML = `<div class="card-title">${escHtml(artist)}</div><div class="card-sub">${list.length} songs</div>`;
      card.appendChild(body);
      card.addEventListener('click', () => showArtistDetail(artist));
      grid.appendChild(card);
    });

    if (!Object.keys(artists).length) grid.appendChild(emptyState('No artists', 'Upload music to see artists.'));
  }

  function showArtistDetail(artistName) {
    currentArtist = artistName;
    document.getElementById('artists-grid').classList.add('hidden');
    const detail = document.getElementById('artist-detail');
    detail.classList.remove('hidden');

    const artistSongs = songs.filter(s => s.artist === artistName);
    const first = artistSongs[0];

    const header = document.getElementById('artist-detail-header');
    header.innerHTML = '';
    header.appendChild(artEl(first?.artDataUrl, 'detail-art'));
    const info = el('div', 'detail-info');
    info.innerHTML = `<h2>${escHtml(artistName)}</h2><p>${artistSongs.length} songs</p>`;
    const playBtn = el('button', 'detail-play-btn', '▶ Play All');
    playBtn.addEventListener('click', () => Player.setQueue(artistSongs.map(s => s.id), 0));
    info.appendChild(playBtn);
    header.appendChild(info);

    const list = document.getElementById('artist-detail-songs');
    list.innerHTML = '';
    artistSongs.forEach((s, i) => list.appendChild(renderSongRow(s, { index: i, allSongs: artistSongs })));
  }

  function showArtistsList() {
    document.getElementById('artists-grid').classList.remove('hidden');
    document.getElementById('artist-detail').classList.add('hidden');
  }

  /* ── PLAYLISTS ── */
  function renderPlaylists() {
    const grid = document.getElementById('playlists-grid');
    grid.innerHTML = '';

    if (!playlists.length) {
      grid.appendChild(emptyState('No playlists yet', 'Tap "+ New Playlist" to create one.'));
      return;
    }

    playlists.forEach(pl => {
      const plSongs = pl.songIds.map(id => songs.find(s => s.id === id)).filter(Boolean);
      const first = plSongs[0];

      const card = el('div', 'card');
      card.appendChild(artEl(first?.artDataUrl));
      const body = el('div', 'card-body');
      body.innerHTML = `<div class="card-title">${escHtml(pl.name)}</div><div class="card-sub">${plSongs.length} songs</div>`;
      card.appendChild(body);
      card.addEventListener('click', () => showPlaylistDetail(pl.id));
      grid.appendChild(card);
    });
  }

  async function showPlaylistDetail(playlistId) {
    currentPlaylistId = playlistId;
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;

    document.getElementById('playlists-grid').classList.add('hidden');
    const detail = document.getElementById('playlist-detail');
    detail.classList.remove('hidden');

    const plSongs = pl.songIds.map(id => songs.find(s => s.id === id)).filter(Boolean);

    const header = document.getElementById('playlist-detail-header');
    header.innerHTML = '';
    header.appendChild(artEl(plSongs[0]?.artDataUrl, 'detail-art'));
    const info = el('div', 'detail-info');
    info.innerHTML = `<h2>${escHtml(pl.name)}</h2><p>${plSongs.length} songs</p>`;
    const playBtn = el('button', 'detail-play-btn', '▶ Play Playlist');
    playBtn.addEventListener('click', () => {
      if (plSongs.length) Player.setQueue(plSongs.map(s => s.id), 0);
    });

    const renameBtn = el('button', 'btn-secondary', 'Rename');
    renameBtn.style.marginTop = '8px';
    renameBtn.addEventListener('click', () => renamePlaylist(pl.id));

    const deleteBtn = el('button', 'btn-secondary', 'Delete');
    deleteBtn.style.marginTop = '8px';
    deleteBtn.style.marginLeft = '8px';
    deleteBtn.addEventListener('click', () => deletePlaylist(pl.id));

    info.appendChild(playBtn);
    info.appendChild(renameBtn);
    info.appendChild(deleteBtn);
    header.appendChild(info);

    const list = document.getElementById('playlist-detail-songs');
    list.innerHTML = '';
    plSongs.forEach((s, i) => list.appendChild(renderSongRow(s, { index: i, allSongs: plSongs, playlistId })));
  }

  function showPlaylistsList() {
    document.getElementById('playlists-grid').classList.remove('hidden');
    document.getElementById('playlist-detail').classList.add('hidden');
    currentPlaylistId = null;
  }

  /* ── FAVORITES ── */
  function renderFavorites() {
    const favs = songs.filter(s => s.favorite);
    const container = document.getElementById('favorites-list');
    container.innerHTML = '';
    if (!favs.length) { container.appendChild(emptyState('No favorites yet', 'Tap ♥ on any song to save it here.')); return; }
    favs.forEach((s, i) => container.appendChild(renderSongRow(s, { index: i, allSongs: favs })));
  }

  /* ── STATS ── */
  async function renderStats() {
    const container = document.getElementById('stats-content');
    container.innerHTML = '<p style="color:var(--text3);font-size:.85rem">Loading stats…</p>';

    const history = await DB.History.getAll();

    // Total listening time in ms
    const totalMs = history.reduce((sum, h) => sum + (h.durationMs || 0), 0);

    // Song play counts
    const songCounts = {};
    history.forEach(h => { songCounts[h.songId] = (songCounts[h.songId] || 0) + 1; });

    // Artist play counts
    const artistCounts = {};
    songs.forEach(s => {
      if (songCounts[s.id]) artistCounts[s.artist] = (artistCounts[s.artist] || 0) + songCounts[s.id];
    });

    // Album play counts
    const albumCounts = {};
    songs.forEach(s => {
      if (songCounts[s.id]) albumCounts[s.album] = (albumCounts[s.album] || 0) + songCounts[s.id];
    });

    const topSongs = Object.entries(songCounts).sort(([,a],[,b]) => b-a).slice(0,5)
      .map(([id, count]) => ({ song: songs.find(s => s.id === id), count })).filter(x => x.song);

    const topArtists = Object.entries(artistCounts).sort(([,a],[,b]) => b-a).slice(0,3);
    const topAlbum = Object.entries(albumCounts).sort(([,a],[,b]) => b-a)[0];

    container.innerHTML = '';

    // Total time
    const timeCard = el('div', 'stat-card');
    timeCard.innerHTML = `<h3>Total Listening Time</h3><div class="stat-number">${formatDuration(totalMs)}</div><div class="stat-label">all time</div>`;
    container.appendChild(timeCard);

    // Total plays
    const playsCard = el('div', 'stat-card');
    playsCard.innerHTML = `<h3>Songs Played</h3><div class="stat-number">${history.length}</div><div class="stat-label">all time</div>`;
    container.appendChild(playsCard);

    // Library size
    const libCard = el('div', 'stat-card');
    libCard.innerHTML = `<h3>Library</h3><div class="stat-number">${songs.length}</div><div class="stat-label">songs in library</div>`;
    container.appendChild(libCard);

    // Top songs
    if (topSongs.length) {
      const songCard = el('div', 'stat-card');
      songCard.innerHTML = '<h3>Top Songs</h3>';
      const list = el('div', 'stat-list');
      topSongs.forEach(({ song, count }, i) => {
        const item = el('div', 'stat-list-item');
        item.innerHTML = `<span class="stat-rank">${i+1}</span><div class="stat-item-info"><div class="stat-item-name">${escHtml(song.title)}</div><div class="stat-item-sub">${escHtml(song.artist)} · ${count} plays</div></div>`;
        list.appendChild(item);
      });
      songCard.appendChild(list);
      container.appendChild(songCard);
    }

    // Top artists
    if (topArtists.length) {
      const artCard = el('div', 'stat-card');
      artCard.innerHTML = '<h3>Top Artists</h3>';
      const list = el('div', 'stat-list');
      topArtists.forEach(([artist, count], i) => {
        const item = el('div', 'stat-list-item');
        item.innerHTML = `<span class="stat-rank">${i+1}</span><div class="stat-item-info"><div class="stat-item-name">${escHtml(artist)}</div><div class="stat-item-sub">${count} plays</div></div>`;
        list.appendChild(item);
      });
      artCard.appendChild(list);
      container.appendChild(artCard);
    }

    // Top album
    if (topAlbum) {
      const albCard = el('div', 'stat-card');
      albCard.innerHTML = `<h3>Most Played Album</h3><div class="stat-number" style="font-size:1.4rem">${escHtml(topAlbum[0])}</div><div class="stat-label">${topAlbum[1]} plays</div>`;
      container.appendChild(albCard);
    }

    if (!history.length) container.innerHTML = '<p style="color:var(--text3)">Play some music to see your stats here!</p>';
  }

  /* ── MINI PLAYER ── */
  function updateMiniPlayer(song) {
    const mp = document.getElementById('mini-player');
    if (!song) { mp.classList.add('hidden'); return; }
    mp.classList.remove('hidden');

    const art = document.getElementById('mini-art');
    const placeholder = document.getElementById('mini-art-placeholder');
    if (song.artDataUrl) {
      art.src = song.artDataUrl;
      art.classList.remove('hidden');
      placeholder.style.display = 'none';
    } else {
      art.classList.add('hidden');
      placeholder.style.display = 'flex';
    }

    document.getElementById('mini-title').textContent = song.title;
    document.getElementById('mini-artist').textContent = song.artist;

    // Update fav button
    const favBtn = document.getElementById('mini-fav-btn');
    favBtn.classList.toggle('active', song.favorite);

    // Sync all song rows
    document.querySelectorAll('.song-row').forEach(row => {
      row.classList.toggle('playing', row.dataset.songId === song.id);
    });

    updateNowPlaying(song);
  }

  function updatePlayState(isPlaying) {
    // Mini player
    document.querySelector('#mini-play-btn .icon-play').classList.toggle('hidden', isPlaying);
    document.querySelector('#mini-play-btn .icon-pause').classList.toggle('hidden', !isPlaying);
    // Now playing
    document.querySelector('#np-play-btn .icon-play').classList.toggle('hidden', isPlaying);
    document.querySelector('#np-play-btn .icon-pause').classList.toggle('hidden', !isPlaying);
  }

  function updateProgress({ progress, currentTime, duration }) {
    const pct = (progress * 100).toFixed(2) + '%';
    document.getElementById('mini-progress-fill').style.width = pct;
    document.getElementById('np-seek-fill').style.width = pct;
    document.getElementById('np-seek-thumb').style.left = pct;
    document.getElementById('np-current-time').textContent = Player.formatTime(currentTime);
    document.getElementById('np-duration').textContent = Player.formatTime(duration);
  }

  /* ── NOW PLAYING ── */
  function updateNowPlaying(song) {
    if (!song) return;
    const npArt = document.getElementById('np-art');
    const npArtPh = document.getElementById('np-art-placeholder');
    if (song.artDataUrl) {
      npArt.src = song.artDataUrl;
      npArt.style.display = 'block';
      npArtPh.style.display = 'none';
    } else {
      npArt.style.display = 'none';
      npArtPh.style.display = 'flex';
    }
    document.getElementById('np-title').textContent = song.title;
    document.getElementById('np-artist').textContent = song.artist;
    document.getElementById('np-fav-btn').classList.toggle('active', song.favorite);
  }

  function showNowPlaying() {
    document.getElementById('now-playing').classList.remove('hidden');
  }

  function hideNowPlaying() {
    document.getElementById('now-playing').classList.add('hidden');
  }

  /* ── QUEUE ── */
  function renderQueue() {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    Player.state.queue.forEach((songId, i) => {
      const song = songs.find(s => s.id === songId);
      if (!song) return;
      const item = el('div', `queue-item${i === Player.state.queueIndex ? ' current' : ''}`);
      item.innerHTML = `<span class="queue-num">${i === Player.state.queueIndex ? '▶' : i+1}</span><div><div class="queue-title">${escHtml(song.title)}</div><div class="queue-sub">${escHtml(song.artist)}</div></div>`;
      item.addEventListener('click', () => {
        Player.state.queueIndex = i;
        Player.playSong(songId);
        document.getElementById('queue-panel').classList.add('hidden');
      });
      list.appendChild(item);
    });
  }

  /* ── CONTEXT MENU ── */
  function showContextMenu(e, songId, playlistId) {
    contextTarget = { songId, playlistId };
    const menu = document.getElementById('context-menu');
    const song = songs.find(s => s.id === songId);

    menu.querySelector('[data-action="toggle-fav"]').textContent = song?.favorite ? '♥ Unfavorite' : '♥ Favorite';
    menu.querySelector('[data-action="remove-from-playlist"]').classList.toggle('hidden', !playlistId);

    menu.classList.remove('hidden');
    // Position near click
    const x = Math.min(e.clientX, window.innerWidth - 210);
    const y = Math.min(e.clientY, window.innerHeight - 250);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    e.stopPropagation();
  }

  function hideContextMenu() {
    document.getElementById('context-menu').classList.add('hidden');
    contextTarget = null;
  }

  /* ── HELPERS ── */
  function emptyState(title, body) {
    const d = el('div', 'empty-state');
    d.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><h3>${escHtml(title)}</h3><p>${escHtml(body)}</p>`;
    return d;
  }

  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key] || 'Unknown';
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    }, {});
  }

  function escHtml(s) {
    return (s || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── FAVORITE TOGGLE ── */
  async function toggleFavorite(songId, btnEl) {
    const meta = songs.find(s => s.id === songId);
    if (!meta) return;
    meta.favorite = !meta.favorite;
    await DB.Songs.updateMeta(meta);
    btnEl?.classList.toggle('active', meta.favorite);
    // If this is the current song, sync player UI
    if (Player.state.currentSong?.id === songId) {
      Player.state.currentSong.favorite = meta.favorite;
      document.getElementById('mini-fav-btn').classList.toggle('active', meta.favorite);
      document.getElementById('np-fav-btn').classList.toggle('active', meta.favorite);
    }
    toast(meta.favorite ? '♥ Added to Favorites' : 'Removed from Favorites');
  }

  /* ── PLAYLIST MANAGEMENT ── */
  async function newPlaylist() {
    const name = await showInputModal('New Playlist', 'Playlist name', 'My Playlist');
    if (!name) return;
    const pl = { id: uid(), name, songIds: [], dateCreated: Date.now() };
    await DB.Playlists.save(pl);
    playlists.push(pl);
    renderPlaylists();
    toast(`Playlist "${name}" created`);
  }

  async function renamePlaylist(playlistId) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const name = await showInputModal('Rename Playlist', 'New name', pl.name);
    if (!name) return;
    pl.name = name;
    await DB.Playlists.save(pl);
    showPlaylistDetail(playlistId);
    toast('Playlist renamed');
  }

  async function deletePlaylist(playlistId) {
    const ok = await showConfirmModal('Delete playlist?', 'This cannot be undone.');
    if (!ok) return;
    await DB.Playlists.delete(playlistId);
    playlists = playlists.filter(p => p.id !== playlistId);
    showPlaylistsList();
    renderPlaylists();
    toast('Playlist deleted');
  }

  async function addSongToPlaylist(songId) {
    if (!playlists.length) {
      toast('No playlists — create one first');
      return;
    }
    // Show playlist picker
    const options = playlists.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    const result = await showSelectModal('Add to Playlist', `<select id="playlist-select">${options}</select>`);
    if (!result) return;
    const playlistId = document.getElementById('playlist-select').value;
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    if (pl.songIds.includes(songId)) { toast('Already in playlist'); return; }
    pl.songIds.push(songId);
    await DB.Playlists.save(pl);
    toast(`Added to "${pl.name}"`);
  }

  async function removeSongFromPlaylist(songId, playlistId) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    pl.songIds = pl.songIds.filter(id => id !== songId);
    await DB.Playlists.save(pl);
    showPlaylistDetail(playlistId);
    toast('Removed from playlist');
  }

  /* ── MODALS ── */
  function showModal(title, bodyHTML) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function hideModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  function showInputModal(title, label, defaultVal = '') {
    return new Promise(resolve => {
      showModal(title, `<input type="text" id="modal-input" placeholder="${label}" value="${escHtml(defaultVal)}" />`);
      const input = document.getElementById('modal-input');
      input.select();
      const confirm = () => { hideModal(); resolve(input.value.trim() || null); };
      const cancel  = () => { hideModal(); resolve(null); };
      document.getElementById('modal-confirm').onclick = confirm;
      document.getElementById('modal-cancel').onclick  = cancel;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') cancel(); });
    });
  }

  function showConfirmModal(title, body) {
    return new Promise(resolve => {
      showModal(title, `<p>${escHtml(body)}</p>`);
      document.getElementById('modal-confirm').onclick = () => { hideModal(); resolve(true); };
      document.getElementById('modal-cancel').onclick  = () => { hideModal(); resolve(false); };
    });
  }

  function showSelectModal(title, bodyHTML) {
    return new Promise(resolve => {
      showModal(title, bodyHTML);
      document.getElementById('modal-confirm').onclick = () => { hideModal(); resolve(true); };
      document.getElementById('modal-cancel').onclick  = () => { hideModal(); resolve(false); };
    });
  }

  /* ── SETTINGS ── */
  async function applyTheme(theme) {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.querySelectorAll('.toggle-btn[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    await DB.Settings.set('theme', theme);
  }

  async function applyAccent(color) {
    document.documentElement.style.setProperty('--accent', color);
    // Compute a slightly lighter version for hover
    document.documentElement.style.setProperty('--accent-hover', color);
    document.documentElement.style.setProperty('--accent-dim', color + '2e');
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color));
    await DB.Settings.set('accent', color);
  }

  /* ── SEEK BAR INTERACTION ── */
  function initSeekBar() {
    const bar = document.getElementById('np-seek-bar');
    let dragging = false;

    const getPos = e => {
      const r = bar.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    };

    bar.addEventListener('mousedown',  e => { dragging = true; Player.seek(getPos(e)); });
    bar.addEventListener('touchstart', e => { dragging = true; Player.seek(getPos(e)); }, { passive: true });
    window.addEventListener('mousemove',  e => { if (dragging) Player.seek(getPos(e)); });
    window.addEventListener('touchmove',  e => { if (dragging) Player.seek(getPos(e)); }, { passive: true });
    window.addEventListener('mouseup',  () => dragging = false);
    window.addEventListener('touchend', () => dragging = false);
  }

  return {
    initNav, showView,
    renderHome, renderSongs, renderAlbums, renderArtists, renderPlaylists, renderFavorites, renderStats,
    updateMiniPlayer, updatePlayState, updateProgress, showNowPlaying, hideNowPlaying,
    renderQueue, showContextMenu, hideContextMenu,
    newPlaylist, addSongToPlaylist, removeSongFromPlaylist, addSelectedToPlaylist,
    enterSelectMode, exitSelectMode,
    applyTheme, applyAccent, initSeekBar,
    toggleFavorite,
    showInputModal, showSelectModal,   // needed by zip-to-playlist handler in App
    // Expose so App can set the shared songs/playlists arrays
    setSongs(s)     { songs = s; },
    setPlaylists(p) { playlists = p; },
    get songs()     { return songs; },
    get playlists() { return playlists; },
    get contextTarget() { return contextTarget; },
    get selectMode()    { return selectMode; },
    get selectedIds()   { return selectedIds; },
  };
})();


/* ═══════════════════════════════════════════════════════════════
   UPLOAD & IMPORT
════════════════════════════════════════════════════════════════ */

/**
 * Collect MP3 File objects from a FileList (expanding ZIPs client-side).
 * Returns an array of File objects.
 */
async function collectMp3Files(files) {
  const mp3Files = [];
  for (const file of Array.from(files)) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const zip = await JSZip.loadAsync(file);
        for (const [name, entry] of Object.entries(zip.files)) {
          if (!entry.dir && name.toLowerCase().endsWith('.mp3')) {
            const blob = await entry.async('blob');
            mp3Files.push(new File([blob], name.split('/').pop(), { type: 'audio/mpeg' }));
          }
        }
      } catch (e) { toast('ZIP error: ' + e.message); }
    } else if (file.name.toLowerCase().endsWith('.mp3')) {
      mp3Files.push(file);
    }
  }
  return mp3Files;
}

/**
 * Process an array of MP3 File objects into IndexedDB.
 * Returns an array of newly-added song meta records.
 */
async function processMp3Files(mp3Files) {
  if (!mp3Files.length) { toast('No MP3 files found'); return []; }

  const progress     = document.getElementById('upload-progress');
  const progressBar  = document.getElementById('upload-progress-bar');
  const progressText = document.getElementById('upload-progress-text');
  progress.classList.remove('hidden');

  const newSongs = [];
  let processed = 0;
  const total = mp3Files.length;

  for (const file of mp3Files) {
    progressText.textContent = `Processing ${processed + 1} of ${total}: ${file.name}`;
    progressBar.style.setProperty('--progress', `${(processed / total * 100).toFixed(0)}%`);

    try {
      const [tags, buffer] = await Promise.all([parseID3(file), readFileAsBuffer(file)]);
      const meta = await buildSongMeta(file, tags);

      // Skip duplicates (same title + artist already in library)
      const existing = UI.songs.find(s => s.title === meta.title && s.artist === meta.artist);
      if (!existing) {
        await DB.Songs.add(meta, buffer);
        UI.setSongs([...UI.songs, meta]);
        newSongs.push(meta);
      }
    } catch (e) {
      console.error('Failed to process:', file.name, e);
    }
    processed++;
  }

  progressBar.style.setProperty('--progress', '100%');
  progressText.textContent = `Done! Added ${newSongs.length} songs.`;
  setTimeout(() => progress.classList.add('hidden'), 2000);

  return newSongs;
}

/** Standard upload — add to library, refresh view */
async function handleFileUpload(files) {
  const mp3Files = await collectMp3Files(files);
  const added = await processMp3Files(mp3Files);
  if (added.length) toast(`Added ${added.length} song${added.length !== 1 ? 's' : ''}`);

  // Refresh current view
  const activeView = document.querySelector('.view.active');
  if (activeView) UI.showView(activeView.id.replace('view-', ''));
}

/**
 * ZIP → Playlist upload flow:
 *  1. Expand the ZIP and collect MP3s.
 *  2. Show a playlist picker (create new or pick existing).
 *  3. Import all songs into the library.
 *  4. Append newly-added (+ any already-existing) songs to the chosen playlist.
 */
async function handleZipToPlaylist(file) {
  toast('Reading ZIP…');
  const mp3Files = await collectMp3Files([file]);
  if (!mp3Files.length) { toast('No MP3 files found in ZIP'); return; }

  // ── Step 1: pick / create target playlist ──
  let playlistId;
  const playlists = UI.playlists;

  if (!playlists.length) {
    const name = await UI.showInputModal('New Playlist', 'Name for this playlist', file.name.replace(/\.zip$/i,''));
    if (!name) return;
    const pl = { id: uid(), name, songIds: [], dateCreated: Date.now() };
    await DB.Playlists.save(pl);
    UI.setPlaylists([...UI.playlists, pl]);
    playlistId = pl.id;
    toast(`Playlist "${name}" created`);
  } else {
    // Offer to create new OR pick existing
    const newOpt = `<option value="__new__">+ Create new playlist…</option>`;
    const opts = playlists.map(p =>
      `<option value="${p.id}">${p.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</option>`
    ).join('');
    const ok = await UI.showSelectModal(
      `Add ${mp3Files.length} songs to playlist`,
      `<select id="playlist-select">${newOpt}${opts}</select>`
    );
    if (!ok) return;
    const val = document.getElementById('playlist-select').value;
    if (val === '__new__') {
      const name = await UI.showInputModal('New Playlist', 'Playlist name', file.name.replace(/\.zip$/i,''));
      if (!name) return;
      const pl = { id: uid(), name, songIds: [], dateCreated: Date.now() };
      await DB.Playlists.save(pl);
      UI.setPlaylists([...UI.playlists, pl]);
      playlistId = pl.id;
    } else {
      playlistId = val;
    }
  }

  // ── Step 2: import songs into library ──
  const newSongs = await processMp3Files(mp3Files);

  // ── Step 3: add ALL songs from the zip (new + pre-existing) to the playlist ──
  const pl = UI.playlists.find(p => p.id === playlistId);
  if (!pl) return;

  // Match zip filenames against library (catches both newly added and pre-existing)
  let addedToPlaylist = 0;
  for (const f of mp3Files) {
    const baseName = f.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
    // Look for a matching song in the full library
    const match = UI.songs.find(s =>
      s.title.toLowerCase() === baseName ||
      s.title.toLowerCase().includes(baseName) ||
      baseName.includes(s.title.toLowerCase())
    );
    const songId = match?.id ?? newSongs.find(s => s.title.toLowerCase() === baseName || baseName.includes(s.title.toLowerCase()))?.id;
    if (songId && !pl.songIds.includes(songId)) {
      pl.songIds.push(songId);
      addedToPlaylist++;
    }
  }

  // Also add all truly new songs (catches any that didn't match by filename)
  for (const song of newSongs) {
    if (!pl.songIds.includes(song.id)) {
      pl.songIds.push(song.id);
      addedToPlaylist++;
    }
  }

  await DB.Playlists.save(pl);
  toast(`Added ${addedToPlaylist} song${addedToPlaylist !== 1 ? 's' : ''} to "${pl.name}"`);

  // Refresh playlists view if active
  const activeView = document.querySelector('.view.active');
  if (activeView) UI.showView(activeView.id.replace('view-', ''));
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT / IMPORT (backup)
════════════════════════════════════════════════════════════════ */
async function exportLibrary() {
  toast('Preparing export…');
  const zip = new JSZip();
  const meta = await DB.Songs.getAllMeta();
  const playlists = await DB.Playlists.getAll();
  const history = await DB.History.getAll();
  const settings = {};

  for (const key of ['theme','accent']) {
    settings[key] = await DB.Settings.get(key);
  }

  zip.file('metadata.json', JSON.stringify({ meta, playlists, history, settings }, null, 2));

  // Add audio files
  const audio = zip.folder('audio');
  for (const song of meta) {
    const buf = await DB.Songs.getAudio(song.id);
    if (buf) audio.file(`${song.id}.mp3`, buf);
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `musicloud-backup-${new Date().toISOString().slice(0,10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Export complete!');
}

async function importLibrary(file) {
  toast('Importing…');
  try {
    const zip = await JSZip.loadAsync(file);
    const metaJSON = await zip.file('metadata.json')?.async('string');
    if (!metaJSON) { toast('Invalid backup file'); return; }

    const { meta, playlists, settings } = JSON.parse(metaJSON);

    for (const song of meta) {
      const audioEntry = zip.file(`audio/${song.id}.mp3`);
      if (audioEntry) {
        const buf = await audioEntry.async('arraybuffer');
        await DB.Songs.add(song, buf);
      } else {
        await DB.Songs.updateMeta(song);
      }
    }

    for (const pl of (playlists || [])) {
      await DB.Playlists.save(pl);
    }

    if (settings?.theme) await DB.Settings.set('theme', settings.theme);
    if (settings?.accent) await DB.Settings.set('accent', settings.accent);

    toast('Import complete! Reload the page.');
    location.reload();
  } catch (e) {
    toast('Import failed: ' + e.message);
    console.error(e);
  }
}


/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER REGISTRATION
════════════════════════════════════════════════════════════════ */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('[MusiCloud] Service Worker registered:', reg.scope);
  } catch (e) {
    console.warn('[MusiCloud] SW registration failed:', e);
  }
}


/* ═══════════════════════════════════════════════════════════════
   APP INIT
════════════════════════════════════════════════════════════════ */
async function init() {
  // 1. Open DB
  await DB.open();

  // 2. Load all data
  const [songsMeta, playlists, theme, accent] = await Promise.all([
    DB.Songs.getAllMeta(),
    DB.Playlists.getAll(),
    DB.Settings.get('theme', 'dark'),
    DB.Settings.get('accent', '#1db954'),
  ]);

  UI.setSongs(songsMeta);
  UI.setPlaylists(playlists);

  // 3. Apply saved settings
  await UI.applyTheme(theme);
  await UI.applyAccent(accent);

  // 4. Wire up navigation
  UI.initNav();
  UI.showView('home');

  // 5. Wire up player callbacks
  Player.on('onTrackChange', song => UI.updateMiniPlayer(song));
  Player.on('onPlayState',   playing => UI.updatePlayState(playing));
  Player.on('onProgress',    prog => UI.updateProgress(prog));
  Player.on('onQueueChange', () => UI.renderQueue());

  // 6. Wire up mini player events
  document.getElementById('mini-play-btn').addEventListener('click', e => { e.stopPropagation(); Player.togglePlay(); });
  document.getElementById('mini-next-btn').addEventListener('click', e => { e.stopPropagation(); Player.next(); });
  document.getElementById('mini-fav-btn').addEventListener('click', e => {
    e.stopPropagation();
    const song = Player.state.currentSong;
    if (song) UI.toggleFavorite(song.id, e.currentTarget);
  });
  document.getElementById('expand-player-btn').addEventListener('click', e => { e.stopPropagation(); UI.showNowPlaying(); });

  // Tap on mini player (not controls) to expand
  document.getElementById('mini-player').addEventListener('click', (e) => {
    if (!e.target.closest('#mini-controls')) UI.showNowPlaying();
  });

  // 7. Now playing controls
  document.getElementById('collapse-player-btn').addEventListener('click', UI.hideNowPlaying);
  document.getElementById('np-play-btn').addEventListener('click', Player.togglePlay.bind(Player));
  document.getElementById('np-prev-btn').addEventListener('click', Player.prev.bind(Player));
  document.getElementById('np-next-btn').addEventListener('click', Player.next.bind(Player));

  document.getElementById('np-shuffle-btn').addEventListener('click', e => {
    const on = Player.toggleShuffle();
    e.currentTarget.classList.toggle('active', on);
    toast(on ? 'Shuffle on' : 'Shuffle off');
  });

  document.getElementById('np-repeat-btn').addEventListener('click', e => {
    const mode = Player.cycleRepeat();
    const btn = e.currentTarget;
    btn.classList.toggle('active', mode !== 'none');
    // Show '1' badge for repeat-one
    btn.title = mode === 'one' ? 'Repeat: One' : mode === 'all' ? 'Repeat: All' : 'Repeat: Off';
    toast(mode === 'one' ? 'Repeat: One' : mode === 'all' ? 'Repeat: All' : 'Repeat: Off');
  });

  document.getElementById('np-fav-btn').addEventListener('click', () => {
    const song = Player.state.currentSong;
    if (song) UI.toggleFavorite(song.id, document.getElementById('np-fav-btn'));
  });

  document.getElementById('volume-slider').addEventListener('input', e => {
    Player.setVolume(parseFloat(e.target.value));
  });

  // Queue panel
  document.getElementById('np-queue-btn').addEventListener('click', () => {
    UI.renderQueue();
    document.getElementById('queue-panel').classList.toggle('hidden');
  });
  document.getElementById('close-queue-btn').addEventListener('click', () => {
    document.getElementById('queue-panel').classList.add('hidden');
  });

  // 8. Init seek bar
  UI.initSeekBar();

  // 9. Search & sort
  document.getElementById('search-input').addEventListener('input', () => UI.renderSongs());
  document.getElementById('sort-select').addEventListener('change', () => UI.renderSongs());

  // 10. File upload
  document.getElementById('file-input').addEventListener('change', e => {
    if (e.target.files.length) handleFileUpload(e.target.files);
    e.target.value = '';
  });

  // 10b. ZIP → Playlist upload
  document.getElementById('zip-playlist-input').addEventListener('change', e => {
    if (e.target.files[0]) handleZipToPlaylist(e.target.files[0]);
    e.target.value = '';
  });

  // 10c. Multi-select mode — toggle button
  document.getElementById('select-mode-btn').addEventListener('click', () => {
    if (UI.selectMode) {
      UI.exitSelectMode();
    } else {
      UI.enterSelectMode();
      // Make sure we're on the songs view
      UI.showView('songs');
    }
  });

  // 10d. Multi-select action bar buttons
  document.getElementById('ms-cancel-btn').addEventListener('click', () => {
    UI.exitSelectMode();
  });

  document.getElementById('ms-select-all-btn').addEventListener('click', () => {
    // Select all visible (filtered) song rows
    document.querySelectorAll('#songs-list .song-row').forEach(row => {
      const id = row.dataset.songId;
      if (id) {
        UI.selectedIds.add(id);
        row.classList.add('selected');
      }
    });
    // Update count label via internal helper — call renderSongs to sync state
    document.getElementById('multiselect-count').textContent =
      `${UI.selectedIds.size} song${UI.selectedIds.size !== 1 ? 's' : ''} selected`;
  });

  document.getElementById('ms-add-queue-btn').addEventListener('click', () => {
    if (!UI.selectedIds.size) { toast('Select at least one song first'); return; }
    // Add in library order
    const toAdd = UI.songs.filter(s => UI.selectedIds.has(s.id));
    toAdd.forEach(s => Player.addToQueue(s.id));
    toast(`Added ${toAdd.length} song${toAdd.length !== 1 ? 's' : ''} to queue`);
    UI.exitSelectMode();
  });

  document.getElementById('ms-add-playlist-btn').addEventListener('click', () => {
    UI.addSelectedToPlaylist();
  });

  // 11. Export / Import
  document.getElementById('export-btn').addEventListener('click', exportLibrary);
  document.getElementById('import-input').addEventListener('change', e => {
    if (e.target.files[0]) importLibrary(e.target.files[0]);
    e.target.value = '';
  });

  // 12. New playlist
  document.getElementById('new-playlist-btn').addEventListener('click', () => UI.newPlaylist());

  // 13. Back buttons
  document.getElementById('back-from-album').addEventListener('click', () => {
    UI.setPlaylists(UI.playlists);
    const view = document.getElementById('view-albums');
    view.classList.add('active');
    UI.renderAlbums();
    document.getElementById('albums-grid').classList.remove('hidden');
    document.getElementById('album-detail').classList.add('hidden');
  });

  document.getElementById('back-from-artist').addEventListener('click', () => {
    document.getElementById('artists-grid').classList.remove('hidden');
    document.getElementById('artist-detail').classList.add('hidden');
  });

  document.getElementById('back-from-playlist').addEventListener('click', () => {
    UI.showView('playlists');
  });

  // 14. Context menu actions
  document.getElementById('context-menu').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    const target = UI.contextTarget;
    if (!target) return;
    UI.hideContextMenu();

    const { songId, playlistId } = target;
    switch (action) {
      case 'play-now':
        Player.setQueue([...UI.songs.map(s=>s.id)], UI.songs.findIndex(s=>s.id===songId));
        break;
      case 'play-next':
        Player.playNext(songId); toast('Plays next');
        break;
      case 'add-to-queue':
        Player.addToQueue(songId); toast('Added to queue');
        break;
      case 'toggle-fav': {
        const btn2 = document.querySelector(`.song-row[data-song-id="${songId}"] .fav-btn`);
        UI.toggleFavorite(songId, btn2);
        break;
      }
      case 'add-to-playlist':
        UI.addSongToPlaylist(songId);
        break;
      case 'remove-from-playlist':
        if (playlistId) UI.removeSongFromPlaylist(songId, playlistId);
        break;
      case 'delete-song': {
        const ok = await new Promise(res => {
          document.getElementById('modal-title').textContent = 'Delete song?';
          document.getElementById('modal-body').innerHTML = '<p>This will permanently remove this song from your library.</p>';
          document.getElementById('modal-overlay').classList.remove('hidden');
          document.getElementById('modal-confirm').onclick = () => { document.getElementById('modal-overlay').classList.add('hidden'); res(true); };
          document.getElementById('modal-cancel').onclick  = () => { document.getElementById('modal-overlay').classList.add('hidden'); res(false); };
        });
        if (!ok) break;
        await DB.Songs.delete(songId);
        UI.setSongs(UI.songs.filter(s => s.id !== songId));
        UI.renderSongs();
        toast('Song deleted');
        break;
      }
    }
  });

  // 15. Close context menu on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#context-menu')) UI.hideContextMenu();
  });

  // 16. Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) {
      document.getElementById('modal-overlay').classList.add('hidden');
    }
  });

  // 17. Theme & accent settings
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => UI.applyTheme(btn.dataset.theme));
  });
  document.querySelectorAll('.swatch').forEach(swatch => {
    swatch.addEventListener('click', () => UI.applyAccent(swatch.dataset.color));
  });

  // 18. Keyboard shortcut: Space to play/pause
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      Player.togglePlay();
    }
    if (e.code === 'ArrowRight' && e.target.tagName !== 'INPUT') Player.next();
    if (e.code === 'ArrowLeft' && e.target.tagName !== 'INPUT') Player.prev();
    if (e.key === 'Escape') {
      UI.hideContextMenu();
      document.getElementById('queue-panel').classList.add('hidden');
    }
  });

  // 19. Register Service Worker
  registerServiceWorker();

  console.log('[MusiCloud] Initialized with', songsMeta.length, 'songs');
}

// Start the app
init().catch(console.error);
