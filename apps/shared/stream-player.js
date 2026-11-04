/* Stream delivery adapter. Existing native video controls and events remain in use. */
(() => {
  'use strict';
  if (window.GPStreamMedia) return;
  const states = new WeakMap();
  const videos = new Set();
  const mediaType = 'application/vnd.apple.mpegurl';
  let pageInactive = false;

  function sourceKeys(originalUrl) {
    try {
      const url = new URL(originalUrl, document.baseURI);
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const keys = [path];
      const marker = path.match(/(?:^|\/)(apps\/|reports\/|Math_Level[ABC]_M9\/assets\/)/);
      if (marker) keys.push(path.slice(marker.index + (path[marker.index] === '/' ? 1 : 0)));
      return [...new Set(keys)];
    } catch (_) { return []; }
  }
  function mappingFor(originalUrl) {
    const registry = window.GPStreamMediaRegistry || {};
    if (!/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(registry.customerHost || '')) return null;
    for (const key of sourceKeys(originalUrl)) {
      const entry = registry.bySource?.[key];
      if (entry && /^[a-f0-9]{32}$/.test(entry.uid || '') &&
          (!entry.status || entry.status === 'ready' || entry.status === 'approved')) {
        return {key, entry, manifest: `https://${registry.customerHost}/${entry.uid}/manifest/video.m3u8`};
      }
    }
    return null;
  }
  function getOriginalSource(video) {
    return states.get(video)?.original || video.getAttribute('data-original-source') || video.getAttribute('src') || '';
  }
  function isStreamVideo(video) {
    const state = states.get(video);
    return Boolean(state && state.mode !== 'direct');
  }
  function removeState(video, clearOwnedSource) {
    const state = states.get(video);
    if (!state) return;
    clearTimeout(state.loadTimer);
    state.listeners.forEach(([name, listener]) => video.removeEventListener(name, listener));
    state.notice?.remove();
    state.closed = true;
    try { video.pause(); } catch (_) { /* Detached video. */ }
    state.hls?.destroy();
    if (clearOwnedSource && state.mode !== 'direct') {
      video.removeAttribute('src');
      if (state.mode === 'native-hls') video.load();
    }
    states.delete(video); videos.delete(video);
    delete video.dataset.gpStreamState;
    delete video.dataset.gpStreamKey;
  }
  function destroyVideo(video) { removeState(video, true); }
  function restoreBufferSettings(state) {
    if (state.primeBufferSettings && state.hls) {
      Object.assign(state.hls.config, state.primeBufferSettings);
      state.primeBufferSettings = null;
    }
  }
  function bufferFirstFrame(state) {
    if (!state.primeBufferSettings) {
      const config = state.hls.config;
      state.primeBufferSettings = {maxBufferLength:config.maxBufferLength,
        maxMaxBufferLength:config.maxMaxBufferLength,maxBufferSize:config.maxBufferSize};
    }
    Object.assign(state.hls.config, {maxBufferLength:1,maxMaxBufferLength:1,maxBufferSize:0});
  }
  function bufferedAt(video, position) {
    try {
      for (let index = 0; index < video.buffered.length; index++) {
        const end = video.buffered.end(index);
        if (position >= video.buffered.start(index) &&
            (position < end || (Number.isFinite(video.duration) && Math.abs(position-video.duration)<0.05 && Math.abs(end-video.duration)<0.05))) return true;
      }
    } catch (_) { /* No buffered media yet. */ }
    return false;
  }
  function beginPrime(state) {
    if (!state || state.closed || state.failed || state.started || !state.primeRequested || document.hidden || pageInactive) return;
    clearTimeout(state.loadTimer);
    state.loadTimer = setTimeout(() => failed(state, 'first-frame-timeout'), 20000);
    if (state.mode === 'hls' && state.manifestReady) {
      state.video.preload = 'auto';
      bufferFirstFrame(state);
      state.hls.startLoad(0);
    }
    else if (state.mode === 'native-hls') {
      state.video.preload = 'auto';
      state.video.load();
    }
  }
  // Opt-in only for a user-selected Math film whose authored Play cover waits
  // for a real loadeddata event. Other lesson and gallery videos stay lazy.
  function primeVideo(video) {
    const state = states.get(video);
    if (!state || state.mode === 'direct' || state.started || state.failed) return video;
    if (state.primed && video.readyState >= 2) return video;
    if (state.primeRequested) return video;
    state.primeRequested = true;
    beginPrime(state);
    return video;
  }
  function listen(state, name, listener) {
    state.video.addEventListener(name, listener);
    state.listeners.push([name, listener]);
  }
  function failed(state, reason) {
    if (state.closed || states.get(state.video) !== state || state.failed) return;
    state.failed = true;
    clearTimeout(state.loadTimer); state.loadTimer = 0;
    state.hls?.stopLoad();
    try { state.video.pause(); } catch (_) { /* Native controls stay available. */ }
    state.video.dataset.gpStreamState = 'error';
    const notice = document.createElement('div');
    notice.className = 'gp-stream-notice';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'The video could not load.';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      if (document.hidden || pageInactive || document.querySelector('[data-m9-reading-quiz]')?.open) return;
      setVideoSource(state.video, state.original, true);
      state.video.play().catch(() => { /* A further tap can use native controls. */ });
    });
    notice.append(text, retry); state.video.after(notice); state.notice = notice;
    state.video.dispatchEvent(new CustomEvent('gpstreamerror', {detail:{reason}}));
    state.video.dispatchEvent(new Event('error'));
  }
  function setVideoSource(video, originalUrl, force = false) {
    if (!video || video.tagName !== 'VIDEO' || !originalUrl) return video;
    const original = String(originalUrl);
    if (original.startsWith('blob:')) return video;
    const previous = states.get(video);
    if (!force && previous?.original === original && !previous.failed) return video;
    removeState(video, true);
    video.setAttribute('data-original-source', original);
    const mapped = mappingFor(original);
    const state = {video, original, mode:'direct', hls:null, listeners:[], loadTimer:0,
      notice:null, closed:false, failed:false, started:false, primed:false,
      primeRequested:false, manifestReady:false, progressTime:0, seekPosition:null, seekPreview:false, suppressSeek:false, skipPauseSeek:false};
    states.set(video, state); videos.add(video);
    if (!mapped) {
      if (video.getAttribute('data-stream-lesson') !== null) {
        state.mode = 'stream';
        video.preload = 'none';
        video.removeAttribute('src');
        video.load();
        failed(state, 'mapping-unavailable');
        return video;
      }
      // An already-running direct reward/overlay must not be restarted merely
      // because the observer discovered its element after insertion.
      if (video.getAttribute('src') !== original) video.src = original;
      return video;
    }
    state.mode = 'stream';
    video.preload = 'none';
    video.dataset.gpStreamKey = mapped.key;
    video.dataset.gpStreamState = 'ready';
    const startTimer = (reason = 'start-timeout') => {
      clearTimeout(state.loadTimer);
      state.loadTimer = setTimeout(() => failed(state, reason), 20000);
    };
    const requestSeekFrame = () => {
      if (!state.hls || state.closed || state.failed || state.suppressSeek || document.hidden || pageInactive ||
          document.querySelector('[data-m9-reading-quiz]')?.open || !Number.isFinite(video.currentTime) ||
          bufferedAt(video, video.currentTime) || state.seekPosition === video.currentTime) return;
      state.seekPosition = video.currentTime;
      state.primeRequested = false;
      state.seekPreview = video.paused;
      if (state.seekPreview) {
        video.preload = 'auto';
        bufferFirstFrame(state);
        video.dataset.gpStreamState = 'seeking';
      } else restoreBufferSettings(state);
      // A dormant loader must be explicitly resumed after Math priming/pause.
      // Paused scrubbing requests only its selected frame and never calls play.
      const loadPosition = Number.isFinite(video.duration) ? Math.min(video.currentTime, Math.max(0,video.duration-0.05)) : video.currentTime;
      state.hls.startLoad(loadPosition);
      if (!state.loadTimer) startTimer('seek-timeout');
    };
    const finishSeekPreview = () => {
      if (state.closed || state.failed || !state.seekPreview || !video.paused || video.readyState < 2 || !bufferedAt(video, video.currentTime)) return;
      state.seekPreview = false;
      state.seekPosition = null;
      clearTimeout(state.loadTimer); state.loadTimer = 0;
      state.hls?.stopLoad();
      restoreBufferSettings(state);
      video.preload = 'none';
      video.dataset.gpStreamState = 'paused';
    };
    listen(state, 'play', () => {
      if (document.hidden || pageInactive || document.querySelector('[data-m9-reading-quiz]')?.open) {
        video.pause(); return;
      }
      if (state.failed) return;
      state.started = true;
      state.progressTime = video.currentTime;
      state.seekPosition = null;
      state.seekPreview = false;
      state.primeRequested = false;
      restoreBufferSettings(state);
      video.dataset.gpStreamState = 'loading';
      startTimer();
      // The original element's requested chapter position is preserved.
      state.hls?.startLoad(Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : -1);
    });
    listen(state, 'playing', () => {
      if (document.hidden || pageInactive || document.querySelector('[data-m9-reading-quiz]')?.open) {
        video.pause(); return;
      }
      clearTimeout(state.loadTimer); state.loadTimer = 0;
      video.dataset.gpStreamState = 'playing';
    });
    for (const name of ['waiting', 'stalled', 'seeking']) {
      listen(state, name, () => {
        if (name === 'seeking') {
          if (bufferedAt(video, video.currentTime) && video.readyState >= 3) return;
          requestSeekFrame();
        }
        if (state.started && !state.failed && !video.paused && !video.ended && !state.loadTimer) startTimer();
      });
    }
    listen(state, 'seeked', () => {
      finishSeekPreview();
      if (!state.seekPreview) state.seekPosition = null;
      state.progressTime = video.currentTime;
      if (!video.paused && video.readyState >= 3) {
        clearTimeout(state.loadTimer); state.loadTimer = 0;
      }
    });
    listen(state, 'timeupdate', () => {
      if (!video.paused && video.readyState >= 3 && video.currentTime > state.progressTime + 0.05) {
        clearTimeout(state.loadTimer); state.loadTimer = 0;
      }
      state.progressTime = video.currentTime;
    });
    listen(state, 'loadeddata', () => {
      if (state.closed || state.failed) return;
      finishSeekPreview();
      if (state.primeRequested && !state.started) {
        clearTimeout(state.loadTimer); state.loadTimer = 0;
        state.primeRequested = false;
        state.primed = true;
        state.hls?.stopLoad();
        restoreBufferSettings(state);
        video.preload = 'none';
        video.dataset.gpStreamState = 'primed';
      }
    });
    listen(state, 'pause', () => {
      const cancelled = state.suppressSeek || state.skipPauseSeek;
      state.skipPauseSeek = false;
      state.seekPosition = null;
      clearTimeout(state.loadTimer); state.loadTimer = 0;
      state.hls?.stopLoad();
      if (!state.failed) video.dataset.gpStreamState = 'paused';
      if (video.seeking && !cancelled) requestSeekFrame();
    });
    listen(state, 'ended', () => {
      clearTimeout(state.loadTimer); state.loadTimer = 0;
      state.hls?.stopLoad();
      if (!state.failed) video.dataset.gpStreamState = 'ended';
    });
    listen(state, 'error', () => failed(state, 'native-error'));
    try {
      // Prefer hls.js when supported: some Chrome versions report native HLS
      // support even when their native playback path is unreliable.
      if (window.Hls?.isSupported()) {
        state.mode = 'hls';
        const hls = new window.Hls({autoStartLoad:false, startFragPrefetch:false,
          maxBufferLength:30, maxMaxBufferLength:60, backBufferLength:30, lowLatencyMode:false});
        state.hls = hls;
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) failed(state, data.type || 'playback-error');
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          state.manifestReady = true;
          if (state.primeRequested) beginPrime(state);
        });
        hls.attachMedia(video);
        hls.loadSource(mapped.manifest);
      } else if (video.canPlayType(mediaType)) {
        state.mode = 'native-hls';
        video.src = mapped.manifest;
      } else {
        failed(state, 'unsupported-browser');
      }
    } catch (_) { failed(state, 'player-unavailable'); }
    return video;
  }
  function scan(root = document) {
    const list = root.tagName === 'VIDEO' ? [root] : [...root.querySelectorAll('video')];
    for (const video of list) {
      if (states.has(video)) continue;
      const original = video.getAttribute('data-original-source') || video.getAttribute('src');
      if (original) setVideoSource(video, original);
    }
  }
  function pauseAll() {
    videos.forEach(video => {
      const state = states.get(video);
      clearTimeout(state?.loadTimer);
      state?.hls?.stopLoad();
      if (state) {
        state.loadTimer = 0;
        state.seekPosition = null; state.seekPreview = false;
        restoreBufferSettings(state);
        state.suppressSeek = true;
        state.skipPauseSeek = !video.paused;
      }
      try { video.pause(); } catch (_) { /* Detached video. */ }
      if (state) state.suppressSeek = false;
    });
  }
  window.GPStreamMedia = Object.freeze({setVideoSource, getOriginalSource, isStreamVideo,
    destroyVideo, primeVideo, pauseAll, scan});
  window.addEventListener('pagehide', () => { pageInactive = true; pauseAll(); });
  window.addEventListener('pageshow', () => {
    pageInactive = false;
    videos.forEach(video => { const state = states.get(video); if (state?.primeRequested) beginPrime(state); });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAll();
    else videos.forEach(video => { const state = states.get(video); if (state?.primeRequested) beginPrime(state); });
  });
  const start = () => {
    scan();
    new MutationObserver(records => {
      if (document.querySelector('[data-m9-reading-quiz]')?.open) pauseAll();
      records.forEach(record => record.addedNodes?.forEach(node => {
        if (node.nodeType === 1) scan(node);
      }));
      videos.forEach(video => { if (!video.isConnected) destroyVideo(video); });
    }).observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['open']});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
