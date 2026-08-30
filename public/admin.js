const $ = (s) => document.querySelector(s),
  fields = [
    "nsfw",
    "copyrighted_characters",
    "brands",
    "public_figures",
    "graphic_violence",
    "non_graphic_violence",
  ];
let poll = null,
  connected = false,
  currentUser = null,
  busy = false;
function text(selector, value) {
  $(selector).textContent = String(value ?? "—");
}
function setConnected(value) {
  connected = value;
  $("#login").hidden = value;
  $("#console").hidden = !value;
  $("#disconnect").hidden = !value;
  if (value && !poll) poll = setInterval(refresh, 5000);
  if (!value && poll) {
    clearInterval(poll);
    poll = null;
  }
}
async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  const r = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    currentUser = null;
    setConnected(false);
    throw new Error(data.error || "unauthorized");
  }
  if (!r.ok) throw new Error(data.error || `request_${r.status}`);
  return data;
}
function renderAdminUsers(data) {
  const list = $("#adminUsersList");
  list.replaceChildren();
  for (const user of data.users || []) {
    const item = document.createElement("li"),
      name = document.createElement("b"),
      meta = document.createElement("small");
    name.textContent = user.username;
    meta.textContent = `${user.active ? "ACTIVE" : "DISABLED"} · ${user.role}`;
    item.append(name, meta);
    list.append(item);
  }
  text(
    "#signedInAs",
    currentUser ? `SIGNED IN AS ${currentUser.username}` : "SIGNED IN",
  );
}
function renderPolicy(policy) {
  for (const name of fields)
    $("#policyForm").elements[name].checked = Boolean(policy[name]);
}
function renderGeneration(settings) {
  $("#generationDuration").value = String(settings.duration || 5);
}
function renderIntegrations(data) {
  for (const [id, key] of [
    ["#videoProviderState", "video_provider"],
    ["#wiroState", "wiro"],
    ["#packagerState", "media_packager"],
    ["#turnstileState", "turnstile"],
    ["#directorState", "director"],
    ["#stripeState", "stripe"],
  ]) {
    const node = $(id),
      value = data[key] || "unknown";
    node.textContent = value.replaceAll("_", " ");
    node.className = [
      "fal",
      "wiro",
      "configured",
      "sandbox_ready",
      "deterministic",
    ].includes(value)
      ? "ok"
      : value === "disabled"
        ? "idle"
        : "warn";
  }
}
function renderStatus(status, meta) {
  document.body.classList.toggle("paused", status.paused);
  text("#stationState", status.paused ? "PAUSED" : "LIVE");
  text(
    "#nowPlaying",
    `${status.now_replay ? "RERUN" : "ON AIR"} · ${status.now_chat || status.now_playing || "waiting"}`,
  );
  text("#viewers", status.viewers || 0);
  text("#buffer", status.buffer_clips || 0);
  text("#generating", status.generating_clips || 0);
  text("#total", status.generated_total || 0);
  text("#lastError", status.last_error || "none");
  text("#bufferSecs", Math.round(status.buffer_secs || 0));
  text("#chatMessages", status.chat_messages || 0);
  text(
    "#bible",
    status.bible_summary?.map((x) => x.form).join(" · ") || "empty",
  );
  text("#sequence", `SEQUENCE ${meta.sequence ?? "—"}`);
  const flow = $("#flow");
  flow.replaceChildren();
  for (const clip of meta.clips || []) {
    const li = document.createElement("li");
    li.className = clip.replay ? "replay" : "fresh";
    const seq = document.createElement("b"),
      mode = document.createElement("em"),
      chat = document.createElement("span");
    seq.textContent = `#${clip.sequence}`;
    mode.textContent = clip.replay
      ? "RERUN"
      : clip.mediaUrl
        ? "FRESH · DIRECT"
        : "FRESH";
    chat.textContent = `${clip.filename || "SOURCE MP4"} · ${clip.chatText || "no attribution"}`;
    li.append(seq, mode, chat);
    flow.append(li);
  }
}
function age(ts) {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h`;
}
function renderQueue(data) {
  const prompts = $("#promptQueue"),
    jobs = $("#jobQueue");
  prompts.replaceChildren();
  jobs.replaceChildren();
  for (const item of data.messages || []) {
    const li = document.createElement("li"),
      top = document.createElement("div"),
      id = document.createElement("b"),
      state = document.createElement("em"),
      time = document.createElement("small"),
      copy = document.createElement("p"),
      controls = document.createElement("div"),
      remove = document.createElement("button");
    li.className = `state-${item.status}`;
    id.textContent = `#${item.id} · ${item.user}`;
    state.textContent = item.status;
    time.textContent = age(item.created_at);
    copy.textContent = item.msg;
    top.append(id, state, time);
    li.append(top, copy);
    if (item.rejection_code) {
      const reason = document.createElement("small");
      reason.textContent = item.rejection_code;
      li.append(reason);
    }
    controls.className = "messageActions";
    if (
      item.status === "queued" ||
      item.status === "failed" ||
      item.status === "rejected"
    ) {
      const action = document.createElement("button");
      action.type = "button";
      action.dataset.messageId = String(item.id);
      action.dataset.action = item.status === "queued" ? "reject" : "requeue";
      action.textContent = item.status === "queued" ? "REJECT" : "REQUEUE";
      controls.append(action);
    }
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.deleteMessage = String(item.id);
    remove.textContent = "DELETE";
    controls.append(remove);
    li.append(controls);
    prompts.append(li);
  }
  if (!data.messages?.length) {
    const li = document.createElement("li");
    li.textContent = "No chat prompts yet.";
    prompts.append(li);
  }
  for (const item of data.jobs || []) {
    const li = document.createElement("li"),
      top = document.createElement("div"),
      id = document.createElement("b"),
      state = document.createElement("em"),
      time = document.createElement("small"),
      prompt = document.createElement("p"),
      meta = document.createElement("small"),
      controls = document.createElement("div");
    li.className = `state-${item.status}`;
    id.textContent = item.id.slice(0, 8);
    state.textContent = item.status;
    time.textContent = age(item.created_at);
    prompt.textContent = item.expanded_prompt;
    meta.textContent = `retry ${item.retry_count || 0}${item.error ? ` · ${item.error}` : ""}`;
    top.append(id, state, time);
    li.append(top, prompt, meta);
    if (item.fal_request_id) {
      const check = document.createElement("button");
      controls.className = "messageActions";
      check.type = "button";
      check.dataset.jobId = item.id;
      check.textContent = `CHECK ${String(item.provider || "PROVIDER").toUpperCase()}`;
      controls.append(check);
      li.append(controls);
    }
    jobs.append(li);
  }
  if (!data.jobs?.length) {
    const li = document.createElement("li");
    li.textContent = "No generation jobs yet.";
    jobs.append(li);
  }
}
function renderClips(data) {
  const list = $("#clipQueue");
  list.replaceChildren();
  for (const item of data.clips || []) {
    const li = document.createElement("li"),
      top = document.createElement("div"),
      id = document.createElement("b"),
      state = document.createElement("em"),
      time = document.createElement("small"),
      copy = document.createElement("p"),
      controls = document.createElement("div"),
      toggle = document.createElement("button"),
      remove = document.createElement("button"),
      packaged = Boolean(item.segment_filename);
    id.textContent = `#${item.id} · ${item.segment_filename || "processing"}`;
    state.textContent = packaged
      ? item.ready
        ? `${item.source} · enabled`
        : `${item.source} · disabled`
      : `${item.source} · incomplete`;
    time.textContent = age(item.generated_at);
    copy.textContent = item.chat_text;
    controls.className = "messageActions";
    toggle.type = "button";
    toggle.dataset.clipAction = String(item.id);
    toggle.dataset.action = packaged
      ? item.ready
        ? "disable"
        : "enable"
      : "repair";
    toggle.textContent = packaged
      ? item.ready
        ? "DISABLE"
        : "ENABLE"
      : "RETRY PACKAGE";
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.clipId = String(item.id);
    remove.textContent = "DELETE VIDEO";
    top.append(id, state, time);
    controls.append(toggle, remove);
    li.append(top, copy, controls);
    list.append(li);
  }
  if (!data.clips?.length) {
    const li = document.createElement("li");
    li.textContent = "No videos found.";
    list.append(li);
  }
}
async function refresh() {
  if (!connected || busy) return;
  busy = true;
  try {
    const [status, meta, queue, clips, integrations] = await Promise.all([
      fetch("/status.json", { cache: "no-store" }).then((r) => r.json()),
      fetch("/live/meta.json", { cache: "no-store" }).then((r) => r.json()),
      request("/api/admin/queue"),
      request("/api/admin/clips"),
      request("/api/admin/integrations"),
    ]);
    renderStatus(status, meta);
    renderQueue(queue);
    renderClips(clips);
    renderIntegrations(integrations);
  } catch (error) {
    if (error.message !== "unauthorized")
      text("#lastError", "control room refresh failed");
  } finally {
    busy = false;
  }
}
async function connect() {
  const [me, policy, generation, users] = await Promise.all([
    request("/api/admin/auth/me"),
    request("/api/admin/policy"),
    request("/api/admin/generation"),
    request("/api/admin/users"),
  ]);
  currentUser = me.user;
  renderPolicy(policy);
  renderGeneration(generation);
  renderAdminUsers(users);
  setConnected(true);
  await refresh();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  text("#loginError", "");
  try {
    await request("/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: $("#username").value.trim(),
        password: $("#password").value,
      }),
    });
    await connect();
  } catch {
    text("#loginError", "Access denied. Check username and password.");
  }
});
$("#bootstrapForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  text("#loginError", "");
  const username = $("#username").value.trim(),
    password = $("#password").value;
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    text("#loginError", "Username must be 3–32 letters, numbers, _ or -.");
    return;
  }
  if (password.length < 12 || password.length > 128) {
    text("#loginError", "Password must be 12–128 characters.");
    return;
  }
  try {
    await request("/api/admin/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        bootstrap_token: $("#bootstrapToken").value,
      }),
    });
    $("#bootstrapForm").hidden = true;
    $("#loginForm").requestSubmit();
  } catch (error) {
    const messages = {
      unauthorized: "Bootstrap token is incorrect.",
      invalid_username: "Username must be 3–32 letters, numbers, _ or -.",
      invalid_password: "Password must be 12–128 characters.",
      bootstrap_disabled: "The first admin has already been created.",
      password_hash_failed: "Password security setup failed on the server.",
      admin_insert_failed: "Admin database insert failed.",
    };
    text(
      "#loginError",
      messages[error.message] || "First admin creation failed.",
    );
  }
});
$("#disconnect").addEventListener("click", async () => {
  await fetch("/api/admin/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
  currentUser = null;
  $("#password").value = "";
  setConnected(false);
});
$("#adminUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  text("#adminUserNote", "");
  try {
    await request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: $("#newAdminUsername").value.trim(),
        password: $("#newAdminPassword").value,
      }),
    });
    e.currentTarget.reset();
    renderAdminUsers(await request("/api/admin/users"));
    text("#adminUserNote", "Admin user created.");
  } catch {
    text("#adminUserNote", "Admin user creation failed.");
  }
});
$("#policyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const policy = Object.fromEntries(
    fields.map((name) => [name, e.currentTarget.elements[name].checked]),
  );
  try {
    const saved = await request("/api/admin/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    });
    renderPolicy(saved);
    text("#policyNote", "Policy saved.");
  } catch {
    text("#policyNote", "Policy update failed.");
  }
});
$("#generationForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const duration = Number($("#generationDuration").value);
  try {
    const saved = await request("/api/admin/generation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ duration }),
    });
    renderGeneration(saved);
    text(
      "#generationNote",
      `${saved.duration}-second clips enabled for new prompts.`,
    );
  } catch {
    text("#generationNote", "Generation setting update failed.");
  }
});
async function stationAction(action) {
  for (const b of document.querySelectorAll(".actions button"))
    b.disabled = true;
  try {
    await request(`/api/admin/${action}`, { method: "POST" });
    await refresh();
  } catch {
    text("#lastError", `${action} request failed`);
  } finally {
    for (const b of document.querySelectorAll(".actions button"))
      b.disabled = false;
  }
}
$("#pause").addEventListener("click", () => stationAction("pause"));
$("#resume").addEventListener("click", () => stationAction("resume"));
$("#refresh").addEventListener("click", refresh);
$("#promptQueue").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-message-id]");
  if (!button) return;
  const id = Number(button.dataset.messageId),
    action = button.dataset.action;
  if (action === "reject" && !confirm(`Reject message #${id}?`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/messages/${id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await refresh();
  } catch {
    text("#lastError", `${action} message #${id} failed`);
  } finally {
    button.disabled = false;
  }
});
$("#promptQueue").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-delete-message]");
  if (!button) return;
  const id = Number(button.dataset.deleteMessage);
  if (
    !confirm(
      `Permanently remove message #${id}? Active generation will be cancelled.`,
    )
  )
    return;
  button.disabled = true;
  try {
    await request(`/api/admin/messages/${id}`, { method: "DELETE" });
    await refresh();
  } catch {
    text("#lastError", `delete message #${id} failed`);
  }
});
$("#clipQueue").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-clip-id]");
  if (!button) return;
  const id = Number(button.dataset.clipId);
  if (
    !confirm(
      `Permanently delete video #${id} from the playlist, database and R2?`,
    )
  )
    return;
  button.disabled = true;
  try {
    await request(`/api/admin/clips/${id}`, { method: "DELETE" });
    await refresh();
  } catch {
    text("#lastError", `delete video #${id} failed`);
  }
});
$("#clipQueue").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-clip-action]");
  if (!button) return;
  const id = Number(button.dataset.clipAction),
    action = button.dataset.action;
  if (
    action === "disable" &&
    !confirm(`Disable video #${id} and remove it from the live rotation?`)
  )
    return;
  button.disabled = true;
  try {
    await request(`/api/admin/clips/${id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await refresh();
  } catch {
    text("#lastError", `${action} video #${id} failed`);
  }
});
$("#jobQueue").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-job-id]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await request(
      `/api/admin/jobs/${encodeURIComponent(button.dataset.jobId)}/provider-status`,
    );
    const http =
      result.provider_http_status && result.provider_http_status !== 200
        ? ` · HTTP ${result.provider_http_status}`
        : "";
    button.textContent =
      result.queue_position === null
        ? `${String(result.provider || "provider").toUpperCase()}: ${result.provider_status || "N/A"}${http}`
        : `${String(result.provider || "provider").toUpperCase()}: ${result.provider_status} #${result.queue_position}${http}`;
  } catch {
    button.textContent = "PROVIDER CHECK FAILED";
  } finally {
    button.disabled = false;
  }
});
async function restoreSession() {
  const response = await fetch("/api/admin/auth/me", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.ok) {
    await connect();
    return;
  }
  const state = await response.json().catch(() => ({}));
  $("#bootstrapForm").hidden = !state.bootstrap_required;
  setConnected(false);
}
restoreSession().catch(() => setConnected(false));
