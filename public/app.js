const $ = (s) => document.querySelector(s),
  video = $("#video"),
  messages = $("#messages");
const DISPLAY_BRAND = "televole";
let hls = null,
  currentSeg = null,
  currentClipId = null,
  currentSequence = null,
  directSequence = null,
  known = [],
  mine = new Set(),
  seenFresh = new Set(),
  since = 0,
  token = "",
  widget = null,
  lastRemoteLikes = 0,
  drag = null,
  hold = null,
  initialLevelLoaded = false,
  sending = false,
  currentReplay = false,
  lastViewerCount = 0;
const prefetchedMp4 = new Map();
let directSwitchToken = 0,
  directCurrentClip = null,
  directQueue = [],
  pendingHls = false,
  directPreparing = false,
  directStallTimer = null,
  directStallRetries = 0,
  pendingLiveEdgeSegment = null,
  liveEdgeBusy = false;
const I18N = {
  tr: {
    title: "Sonsuz televizyon",
    description: "Sohbetin yönettiği sonsuz bir televizyon kanalı.",
    onair: "YAYINDA",
    live: "CANLI",
    rerun: "TEKRAR",
    warming: "kanal hazırlanıyor",
    viewer: (count) => `${count} aktif izleyici`,
    enter: "İZLEMEK İÇİN TIKLA",
    splashBody: "Bu kanal gürültülü ve biraz çılgın.",
    splashHint: "Sesi açıp izlemek için herhangi bir yere tıkla.",
    mute: "Sesi aç veya kapat",
    heart: "Kalp gönder",
    liveEdge: "En güncel yayına dön",
    fullscreenEnter: "Tam ekrana geç",
    fullscreenExit: "Tam ekrandan çık",
    chat: "SOHBET",
    direct: "YAYINI SEN YÖNET",
    username: "USERNAME",
    message: "MESAJ",
    placeholder: "sırada ne yayınlansın?",
    send: "GÖNDER ▶",
    continuity: "SÜREKLİLİK",
    static: "parazit",
    expandChat: "Sohbeti aç",
    collapseChat: "Sohbeti daralt",
    verified: "doğrulandı",
    verificationFailed:
      "Sohbet doğrulaması başarısız oldu; yayını izlemeye devam edebilirsin.",
    verificationUnavailable:
      "Sohbet doğrulaması yüklenemedi; yayını izlemeye devam edebilirsin.",
    verifyFirst: "Önce doğrulamayı tamamla.",
    sendFailed: "Mesaj gönderilemedi. Doğrulamayı tamamlayıp tekrar dene.",
    cooldown: "Yeni bir mesaj göndermek için 1 dakika bekle.",
    chatUnavailable: "Sohbet, kanal doğrulaması bağlandığında açılacak.",
    status: {
      pending: "gönderiliyor",
      queued: "sırada",
      seen: "görüldü",
      generating: "üretiliyor",
      ready: "hazır",
      aired: "yayınlandı",
      failed: "başarısız",
      rejected: "reddedildi",
    },
  },
  en: {
    title: "Endless television",
    description: "An endless television station directed by its chat.",
    onair: "ON AIR",
    live: "LIVE",
    rerun: "RERUN",
    warming: "station warming up",
    viewer: (count) => `${count} active viewer${count === 1 ? "" : "s"}`,
    enter: "CLICK TO ENTER",
    splashBody: "This station is noisy and unhinged.",
    splashHint: "Click anywhere to unmute and watch.",
    mute: "Mute or unmute",
    heart: "Send heart",
    liveEdge: "Return to the latest broadcast",
    fullscreenEnter: "Enter fullscreen",
    fullscreenExit: "Exit fullscreen",
    chat: "CHAT",
    direct: "DIRECT THE STATION",
    username: "USERNAME",
    message: "MESSAGE",
    placeholder: "what should air next?",
    send: "SEND ▶",
    continuity: "CONTINUITY",
    static: "static",
    expandChat: "Expand chat",
    collapseChat: "Collapse chat",
    verified: "verified",
    verificationFailed: "Chat verification failed; watching still works.",
    verificationUnavailable:
      "Chat verification could not load; watching still works.",
    verifyFirst: "Complete verification first.",
    sendFailed: "Message was not sent. Complete verification and try again.",
    cooldown: "Wait 1 minute before sending another message.",
    chatUnavailable: "Chat opens when station verification is connected.",
    status: {
      pending: "pending",
      queued: "queued",
      seen: "seen",
      generating: "generating",
      ready: "ready",
      aired: "aired",
      failed: "failed",
      rejected: "rejected",
    },
  },
};
let language = ["tr", "en"].includes(localStorage.getItem("adsparty.lang"))
  ? localStorage.getItem("adsparty.lang")
  : navigator.language.toLowerCase().startsWith("tr")
    ? "tr"
    : "en";
const copy = () => I18N[language];
const statusLabel = (status) =>
  copy().status[status] || status || copy().status.queued;
function setVerify(key) {
  const note = $("#verifyNote");
  note.dataset.i18n = key || "";
  note.textContent = key ? copy()[key] : "";
}
function applyLanguage(nextLanguage) {
  language = nextLanguage === "en" ? "en" : "tr";
  localStorage.setItem("adsparty.lang", language);
  const c = copy();
  document.documentElement.lang = language;
  document.title = c.title;
  $("#description").content = c.description;
  $("#onairLabel").textContent = c.onair;
  $("#liveMode").textContent = currentReplay ? c.rerun : c.live;
  if (!currentSequence && !currentSeg && directSequence === null)
    $("#onairText").textContent = c.warming;
  $("#viewers").textContent = c.viewer(lastViewerCount);
  $("#splashTitle").textContent = c.enter;
  $("#splashBody").textContent = c.splashBody;
  $("#splashHint").textContent = c.splashHint;
  $("#mute").setAttribute("aria-label", c.mute);
  $("#heart").setAttribute("aria-label", c.heart);
  $("#liveEdge").setAttribute("aria-label", c.liveEdge);
  $("#chatTitle").textContent = c.chat;
  $("#chatSubtitle").textContent = c.direct;
  $("#usernameLabel").textContent = c.username;
  $("#messageLabel").textContent = c.message;
  $("#msg").placeholder = c.placeholder;
  $("#sendButton").textContent = c.send;
  $("#continuityLabel").textContent = c.continuity;
  if (["parazit", "static"].includes($("#propList").textContent))
    $("#propList").textContent = c.static;
  $("#language").value = language;
  setChatCollapsed($("#station").classList.contains("chat-collapsed"));
  const fullscreen = Boolean(document.fullscreenElement);
  $("#fullscreen").setAttribute(
    "aria-label",
    fullscreen ? c.fullscreenExit : c.fullscreenEnter,
  );
  for (const state of document.querySelectorAll(".bubble i[data-status]"))
    state.textContent = statusLabel(state.dataset.status);
  const verifyKey = $("#verifyNote").dataset.i18n;
  if (verifyKey) setVerify(verifyKey);
}
function prefetchMp4(clips = [], preferredUrl = null) {
  const connection = navigator.connection;
  if (document.visibilityState === "hidden" || connection?.saveData) return;
  if (["slow-2g", "2g"].includes(connection?.effectiveType)) return;
  const target =
    preferredUrl ||
    directQueue[0]?.mediaUrl ||
    (directSequence === null ? clips.at(-1)?.mediaUrl : null);
  if (
    target &&
    target !== video.currentSrc &&
    /^https:\/\/[^/]+\.fal\.media\//i.test(target)
  )
    warmMp4(target);
  for (const [url, warmup] of [...prefetchedMp4]) {
    if (url === target) continue;
    warmup.removeAttribute("src");
    warmup.load();
    prefetchedMp4.delete(url);
  }
}
function warmMp4(url) {
  if (prefetchedMp4.has(url)) return prefetchedMp4.get(url);
  const warmup = document.createElement("video");
  warmup.muted = true;
  warmup.preload = "auto";
  warmup.playsInline = true;
  warmup.src = url;
  warmup.load();
  prefetchedMp4.set(url, warmup);
  return warmup;
}
async function prepareDirectSource(url) {
  if (video.currentSrc === url && video.readyState >= 2) return true;
  const warmup = warmMp4(url);
  if (warmup.readyState >= 2) return true;
  return new Promise((resolve) => {
    let finished = false;
    const done = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(ready);
    };
    warmup.addEventListener("canplay", () => done(true), { once: true });
    warmup.addEventListener("error", () => done(false), { once: true });
    const timeout = setTimeout(() => done(warmup.readyState >= 2), 8000);
  });
}
function applyBrand() {
  $("#brand").textContent = DISPLAY_BRAND;
  document.title = copy().title;
}
function initAnalytics(id) {
  if (!/^G-[A-Z0-9]+$/.test(id || "") || window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", id, { anonymize_ip: true });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
}
const segName = (u) => (u || "").split("/").pop()?.split("?")[0] || "";
function highest(details) {
  return [...details].sort(
    (a, b) =>
      Number(segName(b.url).slice(0, 6)) - Number(segName(a.url).slice(0, 6)),
  )[0];
}
function startPlayer() {
  clearDirectStall();
  directSwitchToken++;
  directSequence = null;
  directCurrentClip = null;
  directQueue = [];
  pendingHls = false;
  directPreparing = false;
  video.classList.remove("video-switching");
  if (hls) {
    hls.destroy();
    hls = null;
  }
  initialLevelLoaded = false;
  if (window.Hls?.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 2, enableWorker: true });
    hls.loadSource("/live/playlist.m3u8");
    hls.attachMedia(video);
    hls.on(Hls.Events.LEVEL_LOADED, (_, d) => {
      known = d.details.fragments;
      if (initialLevelLoaded) return;
      initialLevelLoaded = true;
      const f = pendingLiveEdgeSegment
        ? known.find(
            (fragment) => segName(fragment.url) === pendingLiveEdgeSegment,
          ) || highest(known)
        : highest(known);
      pendingLiveEdgeSegment = null;
      if (f && Number.isFinite(f.start)) video.currentTime = f.start + 0.05;
    });
    hls.on(Hls.Events.FRAG_CHANGED, (_, d) =>
      setSegment(segName(d.frag.url), Number(d.frag.sn)),
    );
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        hls.destroy();
        hls = null;
        setTimeout(startPlayer, 1500);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = "/live/playlist.m3u8";
    video.addEventListener(
      "loadedmetadata",
      () => {
        pendingLiveEdgeSegment = null;
        video.play().catch(() => {});
      },
      { once: true },
    );
  }
  video.play().catch(() => {});
}
function queueDirect(c) {
  if (
    !c?.mediaUrl ||
    c.sequence === directSequence ||
    directQueue.some((item) => item.sequence === c.sequence)
  )
    return;
  directQueue.push(c);
  directQueue.sort((a, b) => a.sequence - b.sequence);
  // Preserve FIFO order if playback falls behind the station clock.
  directQueue = directQueue.slice(0, 6);
}
function advanceDirect() {
  if (directPreparing) return;
  const next = directQueue.shift();
  if (next) playDirect(next, true);
  else if (pendingHls) startPlayer();
}
function clearDirectStall() {
  if (directStallTimer !== null) clearTimeout(directStallTimer);
  directStallTimer = null;
}
function watchDirectStall() {
  if (directSequence === null || video.ended || directPreparing) return;
  const sequence = directSequence;
  const stalledAt = video.currentTime;
  clearDirectStall();
  directStallTimer = setTimeout(() => {
    directStallTimer = null;
    if (
      directSequence !== sequence ||
      video.ended ||
      video.currentTime > stalledAt + 0.15
    )
      return;
    if (directStallRetries >= 1) {
      directStallRetries = 0;
      const next = directQueue.shift();
      if (next) playDirect(next, true);
      else startPlayer();
      return;
    }
    directStallRetries++;
    const resumeAt = video.currentTime;
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (directSequence !== sequence) return;
        if (Number.isFinite(video.duration))
          video.currentTime = Math.min(
            resumeAt,
            Math.max(0, video.duration - 0.1),
          );
        video.play().catch(() => {});
      },
      { once: true },
    );
    video.load();
  }, 8000);
}
async function playDirect(c, force = false) {
  if (directSequence === c.sequence) return;
  if (
    !force &&
    (directPreparing || (directSequence !== null && !video.ended))
  ) {
    queueDirect(c);
    return;
  }
  const switchToken = ++directSwitchToken;
  directPreparing = true;
  const prepared = await prepareDirectSource(c.mediaUrl);
  if (directSwitchToken !== switchToken) return;
  directPreparing = false;
  if (!prepared) {
    queueDirect(c);
    setTimeout(() => {
      if (!directPreparing && (directSequence === null || video.ended)) {
        const retry = directQueue.shift();
        if (retry) playDirect(retry, true);
      }
    }, 1500);
    return;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  clearDirectStall();
  directStallRetries = 0;
  directSequence = c.sequence;
  directCurrentClip = c;
  directQueue = directQueue.filter((item) => item.sequence !== c.sequence);
  setLikeClip(c.clipId);
  currentSequence = c.sequence;
  currentSeg = null;
  const sequence = c.sequence;
  const hasVisibleVideo = Boolean(video.currentSrc && video.readyState >= 2);
  if (hasVisibleVideo) {
    video.classList.add("video-switching");
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (directSequence !== sequence || directSwitchToken !== switchToken) {
    return;
  }
  let revealed = false;
  const reveal = () => {
    if (
      revealed ||
      directSequence !== sequence ||
      directSwitchToken !== switchToken
    )
      return;
    revealed = true;
    video.play().catch(() => {});
    requestAnimationFrame(() => video.classList.remove("video-switching"));
  };
  video.addEventListener("canplay", reveal, { once: true });
  video.addEventListener("error", reveal, { once: true });
  if (video.currentSrc === c.mediaUrl && video.readyState >= 2) {
    video.currentTime = 0;
    reveal();
  } else {
    video.pause();
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (directSequence !== sequence || directSwitchToken !== switchToken)
          return;
        video.currentTime = 0;
        video.play().catch(() => {});
      },
      { once: true },
    );
    video.src = c.mediaUrl;
    video.load();
    setTimeout(reveal, hasVisibleVideo ? 2500 : 8000);
  }
}
async function setSegment(seg, sequence = null) {
  if (
    !/^\d{6}\.ts$/.test(seg) ||
    (seg === currentSeg && sequence === currentSequence)
  )
    return;
  currentSeg = seg;
  currentClipId = null;
  currentSequence = sequence;
  await refreshMeta();
  await refreshLikes();
}
function addBubble(x, optimistic = false) {
  const existing = document.querySelector(`[data-id="${x.id}"]`);
  if (existing) {
    existing.className = `bubble ${x.status || ""}`;
    const state = existing.querySelector("i");
    state.dataset.status = x.status || "queued";
    state.textContent = statusLabel(x.status);
    return;
  }
  const d = document.createElement("div");
  d.className = `bubble ${x.status || ""}`;
  d.dataset.id = x.id;
  const b = document.createElement("b");
  b.textContent = `<${x.user}> `;
  const t = document.createTextNode(x.msg);
  const time = document.createElement("time");
  const createdAt = Number(x.created_at) || Date.now() / 1000;
  time.dateTime = new Date(createdAt * 1000).toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(createdAt * 1000);
  const i = document.createElement("i");
  i.dataset.status = optimistic ? "pending" : x.status || "queued";
  i.textContent = statusLabel(i.dataset.status);
  const meta = document.createElement("span");
  meta.className = "bubbleMeta";
  meta.append(time, i);
  d.append(b, t, meta);
  messages.append(d);
  while (messages.children.length > 80) messages.firstChild.remove();
  messages.scrollTop = messages.scrollHeight;
}
async function pollChat() {
  try {
    const activeIds = [...messages.querySelectorAll(".bubble i[data-status]")]
      .filter(
        (state) =>
          !["aired", "failed", "rejected"].includes(state.dataset.status),
      )
      .map((state) => state.closest(".bubble")?.dataset.id)
      .filter((id) => /^\d+$/.test(id || ""));
    const ids = [...new Set([...mine, ...activeIds])].slice(-50).join(",");
    const r = await fetch(`/api/chat?since=${since}&mine=${ids}`, {
      cache: "no-store",
    });
    const j = await r.json();
    for (const x of j.msgs) {
      addBubble(x);
      since = Math.max(since, x.id);
    }
    if (j.mine)
      for (const [id, status] of Object.entries(j.mine)) {
        const e = document.querySelector(`[data-id="${id}"]`);
        if (e) {
          e.className = `bubble ${status}`;
          const state = e.querySelector("i");
          state.dataset.status = status;
          state.textContent = statusLabel(status);
        }
        if (["aired", "failed", "rejected"].includes(status))
          mine.delete(Number(id));
      }
    lastViewerCount = Number(j.viewers) || 0;
    $("#viewers").textContent = copy().viewer(lastViewerCount);
  } catch {}
  setTimeout(pollChat, 2500);
}
function relativeAge(ts) {
  const seconds = Math.max(1, Math.floor(Date.now() / 1000 - Number(ts || 0)));
  if (language === "en") {
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  if (seconds < 60) return `${seconds} sn önce`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} sa önce`;
  return `${Math.floor(seconds / 86400)} gün önce`;
}
async function refreshMeta() {
  try {
    const m = await fetch("/live/meta.json", { cache: "no-store" }).then((r) =>
        r.json(),
      ),
      latest = m.clips?.at(-1);
    if (directSequence !== null) {
      const later = (m.clips || []).filter(
        (clip) => Number(clip.sequence) > directSequence,
      );
      for (const clip of later) if (clip.mediaUrl) queueDirect(clip);
      if (later.some((clip) => clip.filename)) pendingHls = true;
      if (video.ended) advanceDirect();
    } else if (latest?.mediaUrl) {
      playDirect(latest);
    }
    prefetchMp4(m.clips);
    let currentIndex =
      m.clips?.findIndex((x) => x.sequence === currentSequence) ?? -1;
    if (currentIndex < 0)
      currentIndex =
        m.clips?.findLastIndex((x) => x.filename === currentSeg) ?? -1;
    const c =
      currentIndex >= 0 ? m.clips[currentIndex] : directCurrentClip || latest;
    if (c) {
      setLikeClip(c.clipId);
      if (!hls && !directSequence && !currentSeg) {
        currentSeg = c.filename;
        currentSequence = c.sequence;
        refreshLikes();
      }
      currentReplay = Boolean(c.replay);
      $("#liveMode").textContent = currentReplay ? copy().rerun : copy().live;
      $("#onairText").textContent = c.chatText || c.filename;
      $("#airAge").textContent = c.replay ? relativeAge(c.generatedAt) : "";
      if (!c.replay) seenFresh.add(`${c.sequence}:${c.filename || c.mediaUrl}`);
    }
    const later = m.clips
      ?.slice(currentIndex + 1)
      .find(
        (x) =>
          !x.replay &&
          !seenFresh.has(`${x.sequence}:${x.filename || x.mediaUrl}`),
      );
    if (later?.mediaUrl) playDirect(later);
    else if (later && hls) {
      const archived = m.clips.filter((x) => x.filename),
        i = archived.indexOf(later);
      if (known[i] && Number.isFinite(known[i].start))
        video.currentTime = known[i].start + 0.05;
    }
  } catch {}
}
async function preloadLiveSegment(filename) {
  if (!/^\d{6}\.ts$/.test(filename || "")) return false;
  try {
    const response = await fetch(`/live/${filename}`, { cache: "force-cache" });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0;
  } catch {
    return false;
  }
}
function setLiveEdgeBusy(busy) {
  liveEdgeBusy = busy;
  const button = $("#liveEdge");
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
  button.setAttribute("aria-busy", String(busy));
}
async function goToLiveEdge() {
  if (liveEdgeBusy) return;
  setLiveEdgeBusy(true);
  const button = $("#liveEdge");
  button.classList.remove("live-edge-error", "live-edge-confirmed");
  try {
    const meta = await fetch("/live/meta.json", { cache: "no-store" }).then(
      (response) => response.json(),
    );
    const liveTail = meta.clips?.slice(-3) || [];
    const target = liveTail[0];
    if (!target) return;
    if (target.mediaUrl) {
      directQueue = liveTail.slice(1).filter((clip) => clip.mediaUrl);
      pendingHls = liveTail.slice(1).some((clip) => clip.filename);
      prefetchMp4(liveTail, directQueue[0]?.mediaUrl || target.mediaUrl);
      await playDirect(target, true);
    } else if (target.filename) {
      if (!(await preloadLiveSegment(target.filename)))
        throw new Error("live_edge_preload_failed");
      pendingLiveEdgeSegment = target.filename;
      startPlayer();
    } else {
      throw new Error("live_edge_unavailable");
    }
    button.classList.add("live-edge-confirmed");
    setTimeout(() => button.classList.remove("live-edge-confirmed"), 500);
  } catch {
    button.classList.add("live-edge-error");
    setTimeout(() => button.classList.remove("live-edge-error"), 1200);
  } finally {
    setLiveEdgeBusy(false);
  }
}
function heart(x = innerWidth / 2, y = innerHeight / 2) {
  const h = document.createElement("span");
  h.className = "floating";
  h.textContent = "♥";
  h.style.left = `${x}px`;
  h.style.top = `${y}px`;
  $("#hearts").append(h);
  setTimeout(() => h.remove(), 1300);
}
function setLikeClip(clipId) {
  const next =
    Number.isSafeInteger(Number(clipId)) && Number(clipId) > 0
      ? Number(clipId)
      : null;
  if (next === currentClipId) return;
  currentClipId = next;
  lastRemoteLikes = 0;
  $("#likes").textContent = "0";
}
function likeTarget() {
  if (currentClipId)
    return {
      query: `clip=${currentClipId}`,
      body: { clip_id: currentClipId },
    };
  if (currentSeg)
    return {
      query: `seg=${encodeURIComponent(currentSeg)}`,
      body: { seg: currentSeg },
    };
  return null;
}
async function sendLike() {
  const target = likeTarget();
  if (!target) return;
  heart();
  $("#likes").textContent = String(Number($("#likes").textContent) + 1);
  fetch("/api/like", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target.body),
  })
    .then((r) => r.json())
    .then((j) => {
      if (Number.isFinite(Number(j.likes)))
        $("#likes").textContent = String(Number(j.likes));
    })
    .catch(() => {});
}
async function refreshLikes() {
  const target = likeTarget();
  if (!target) return;
  try {
    const j = await fetch(`/api/like?${target.query}`, {
      cache: "no-store",
    }).then((r) => r.json());
    const diff = Math.min(5, Math.max(0, j.likes - lastRemoteLikes));
    for (let i = 0; i < diff; i++)
      setTimeout(
        () => heart(innerWidth * 0.65 + Math.random() * 80, innerHeight * 0.7),
        i * 120,
      );
    lastRemoteLikes = j.likes;
    $("#likes").textContent = j.likes;
  } catch {}
}
function seekIndex(delta) {
  if (!hls || !known.length) return;
  let i = known.findIndex((x) => segName(x.url) === currentSeg);
  i = (i + delta + known.length) % known.length;
  video.currentTime = known[i].start + 0.05;
}
function commitSwipe(delta) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    video.style.translate = "";
    seekIndex(delta);
    return;
  }
  const out = delta > 0 ? -1 : 1;
  video.style.transition = "translate 180ms ease-in";
  video.style.translate = `0 ${out * 100}vh`;
  setTimeout(() => {
    seekIndex(delta);
    video.style.transition = "none";
    video.style.translate = `0 ${-out * 100}vh`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        video.style.transition = "translate 220ms ease-out";
        video.style.translate = "";
      }),
    );
    setTimeout(() => (video.style.transition = ""), 260);
  }, 180);
}
function cancelGesture() {
  clearTimeout(hold);
  video.style.transition = "";
  video.style.translate = "";
  drag = null;
}
video.addEventListener("waiting", watchDirectStall);
video.addEventListener("stalled", watchDirectStall);
video.addEventListener("playing", clearDirectStall);
video.addEventListener("ended", () => {
  clearDirectStall();
  advanceDirect();
});
$("#screen").addEventListener("pointerdown", (e) => {
  e.currentTarget.setPointerCapture?.(e.pointerId);
  video.style.transition = "none";
  drag = { y: e.clientY, t: performance.now(), moved: false };
  hold = setTimeout(() => {
    for (let i = 0; i < 8; i++)
      setTimeout(
        () => heart(e.clientX + Math.random() * 50 - 25, e.clientY),
        i * 100,
      );
  }, 220);
});
$("#screen").addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (Math.abs(dy) > 12) {
    drag.moved = true;
    clearTimeout(hold);
  }
  video.style.translate = `0 ${Math.max(-120, Math.min(120, dy))}px`;
});
$("#screen").addEventListener("pointerup", (e) => {
  if (!drag) return;
  clearTimeout(hold);
  const dy = e.clientY - drag.y,
    v = Math.abs(dy) / (performance.now() - drag.t);
  const moved = drag.moved;
  drag = null;
  if (Math.abs(dy) > 90 || v > 0.55) commitSwipe(dy < 0 ? 1 : -1);
  else {
    video.style.transition = "translate 140ms ease-out";
    video.style.translate = "";
    if (!moved) sendLike();
    setTimeout(() => (video.style.transition = ""), 160);
  }
});
$("#screen").addEventListener("pointercancel", cancelGesture);
$("#heart").addEventListener("click", (e) => {
  e.stopPropagation();
  sendLike();
});
$("#liveEdge").addEventListener("pointerdown", (e) => e.stopPropagation());
$("#liveEdge").addEventListener("click", (e) => {
  e.stopPropagation();
  goToLiveEdge();
});
function enter() {
  video.muted = false;
  video.play().catch(() => {});
  $("#splash").hidden = true;
  $("#splash").style.display = "none";
  $("#mute").textContent = "🔊";
}
$("#splash").addEventListener("pointerdown", (e) => e.stopPropagation());
$("#splash").addEventListener("pointerup", (e) => {
  e.stopPropagation();
  enter();
});
$("#splash").addEventListener("click", enter);
$("#splash").addEventListener("keydown", (e) => {
  if (e.key === "Enter") enter();
});
$("#mute").addEventListener("click", (e) => {
  e.stopPropagation();
  video.muted = !video.muted;
  e.currentTarget.textContent = video.muted ? "🔇" : "🔊";
});
$("#controls").addEventListener("pointerdown", (e) => e.stopPropagation());
function setChatCollapsed(collapsed) {
  $("#station").classList.toggle("chat-collapsed", collapsed);
  $("#chatToggle").setAttribute("aria-expanded", String(!collapsed));
  $("#chatToggle").setAttribute(
    "aria-label",
    collapsed ? copy().expandChat : copy().collapseChat,
  );
  $("#chatToggle").textContent = `${copy().chat} ${collapsed ? "▲" : "▼"}`;
}
setChatCollapsed(matchMedia("(max-width:760px)").matches);
applyLanguage(language);
$("#language").addEventListener("change", (e) => {
  applyLanguage(e.currentTarget.value);
  refreshMeta();
});
$("#chatToggle").addEventListener("click", (e) => {
  e.stopPropagation();
  setChatCollapsed(!$("#station").classList.contains("chat-collapsed"));
});
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if ($("#station").requestFullscreen) {
      await $("#station").requestFullscreen();
      return;
    }
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  } catch {
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  }
}
$("#fullscreen").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  document.body.classList.toggle("fullscreen-view", active);
  $("#fullscreen").textContent = active ? "✕" : "⛶";
  $("#fullscreen").setAttribute(
    "aria-label",
    active ? copy().fullscreenExit : copy().fullscreenEnter,
  );
});
function renderTurnstile(sitekey) {
  const ready = () => typeof window.turnstile?.render === "function";
  const mount = () => {
    if (widget !== null || !ready()) return;
    widget = turnstile.render("#turnstileWidget", {
      sitekey,
      theme: "dark",
      size: "flexible",
      callback: (t) => {
        token = t;
        setVerify("verified");
      },
      "expired-callback": () => {
        token = "";
        turnstile.reset(widget);
      },
      "error-callback": () => {
        setVerify("verificationFailed");
      },
    });
  };
  if (ready()) {
    mount();
    return;
  }
  const existing = [...document.scripts].find((s) =>
    s.src.startsWith("https://challenges.cloudflare.com/turnstile/"),
  );
  const script =
    existing ||
    Object.assign(document.createElement("script"), {
      src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
      async: true,
      defer: true,
    });
  script.addEventListener("load", mount, { once: true });
  if (!existing) document.head.append(script);
  setTimeout(() => {
    if (widget === null) setVerify("verificationUnavailable");
  }, 6000);
}
const savedNick = localStorage.getItem("adsparty.nick") || "";
$("#nick").value = /^[A-Za-z0-9_-]{1,18}$/.test(savedNick) ? savedNick : "";
$("#nickCount").textContent = `${$("#nick").value.length}/18`;
$("#nick").addEventListener("input", (e) => {
  $("#nickCount").textContent = `${e.target.value.length}/18`;
});
$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending) return;
  const user = $("#nick").value,
    msg = $("#msg").value.trim();
  if (!token) {
    setVerify("verifyFirst");
    return;
  }
  sending = true;
  $("#chatForm button").disabled = true;
  const pending = `pending-${Date.now()}`;
  addBubble({ id: pending, user, msg, status: "pending" }, true);
  const reconcile = setTimeout(
    () => document.querySelector(`[data-id="${pending}"]`)?.remove(),
    20_000,
  );
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, msg, cf_token: token }),
    });
    const j = await r.json();
    clearTimeout(reconcile);
    document.querySelector(`[data-id="${pending}"]`)?.remove();
    if (!r.ok) throw new Error(j.error);
    localStorage.setItem("adsparty.nick", user);
    addBubble({ id: j.id, user, msg, status: j.status });
    mine.add(j.id);
    $("#msg").value = "";
  } catch (error) {
    clearTimeout(reconcile);
    const cooldown = error instanceof Error && error.message === "cooldown";
    if (!cooldown && !document.querySelector(`[data-id="${pending}"]`))
      addBubble({ id: pending, user, msg, status: "failed" });
    const p = document.querySelector(`[data-id="${pending}"]`);
    if (cooldown) p?.remove();
    else if (p) {
      p.className = "bubble failed";
      p.querySelector("i").dataset.status = "failed";
      p.querySelector("i").textContent = statusLabel("failed");
    }
    setVerify(cooldown ? "cooldown" : "sendFailed");
  } finally {
    sending = false;
    $("#chatForm button").disabled = false;
    token = "";
    if (widget !== null) turnstile.reset(widget);
  }
});
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    applyBrand();
    initAnalytics(c.ga_measurement_id);
    if (c.chat_enabled) renderTurnstile(c.turnstile_site_key);
    else {
      $("#chatForm button").disabled = true;
      setVerify("chatUnavailable");
    }
  });
startPlayer();
pollChat();
refreshMeta();
setInterval(refreshMeta, 3000);
setInterval(refreshLikes, 3000);
