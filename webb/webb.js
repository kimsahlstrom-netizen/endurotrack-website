/*
 * Maxvarv på webben: log in with the app account and see your rides, the
 * rides of riders you follow, and find/follow riders. Uses the same Supabase
 * project, publishable key and queries as the app, so the same row level
 * security applies (private rides, privacy zones, private profiles, blocks).
 * All text from the database is set with textContent (never as HTML).
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://xhxugrpbypzushqkknnd.supabase.co";
  var SUPABASE_KEY = "sb_publishable_RBqx84SpN7z1IBwbItBtDA_05goMtyP";
  var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var me = null;              // auth user id
  var following = new Set();  // user ids I follow
  var requested = new Set();  // pending follow requests I sent
  var blocked = new Set();
  var profiles = {};          // id -> profile
  var map = null;
  var lastTab = "feed";

  var RIDE_COLUMNS = "id, user_id, title, started_at, duration_seconds, distance_meters, average_speed_kmh, " +
    "max_speed_kmh, ascent_meters, share_route, activity_type, note, laps, visibility";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(id, on) { $(id).hidden = !on; }
  function status(text) { $("status").textContent = text || ""; }

  // ---------- formatting ----------
  function duration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }
  function lapTime(sec, tenths) {
    if (!tenths) return duration(sec);
    var t = Math.round(sec * 10);
    return Math.floor(t / 600) + ":" + pad(Math.floor((t % 600) / 10)) + "," + (t % 10);
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function km(m) { return ((m || 0) / 1000).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function whole(n) { return n == null ? "–" : String(Math.round(n)); }
  function date(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) +
      " " + d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  }
  var VEHICLES = {
    motocross: ["MX", "#ffd200", "#000", "Motocross"],
    enduro: ["EN", "#1f5c45", "#fff", "Enduro"],
    snowmobile: ["SN", "#2f6e9e", "#fff", "Skoter"],
    atv: ["ATV", "#111315", "#fff", "ATV"]
  };
  function plate(type) {
    var v = VEHICLES[type] || VEHICLES.enduro;
    var p = el("span", "plate", v[0]);
    p.style.background = v[1]; p.style.color = v[2];
    return p;
  }
  function avatar(profile) {
    var a = el("div", "avatar");
    var url = profile && profile.avatar_url;
    if (url && /^https:\/\//.test(url)) {
      var img = el("img"); img.src = url; img.alt = ""; img.loading = "lazy";
      img.onerror = function () { a.textContent = initial(profile); };
      a.appendChild(img);
    } else {
      a.textContent = initial(profile);
    }
    return a;
  }
  function initial(p) { return ((p && (p.display_name || p.username)) || "?").trim().charAt(0).toUpperCase(); }
  function displayName(p) { return (p && (p.display_name || p.username)) || "Förare"; }
  function stat(value, label) {
    var s = el("div", "stat");
    s.appendChild(el("b", null, value));
    s.appendChild(el("span", null, label));
    return s;
  }

  // ---------- auth ----------
  async function start() {
    var res = await db.auth.getSession();
    var session = res.data && res.data.session;
    if (session) await signedIn(session.user); else signedOut();
  }

  function signedOut() {
    me = null;
    show("login", true); show("app", false); show("detail", false);
    $("who").hidden = true; $("logout").hidden = true;
    status("");
  }

  async function signedIn(user) {
    me = user.id;
    show("login", false); show("app", true); show("detail", false);
    $("logout").hidden = false;
    var p = await db.from("profiles").select("id, username, display_name, avatar_url").eq("id", me).maybeSingle();
    if (p.data) { profiles[me] = p.data; $("who").textContent = "@" + p.data.username; $("who").hidden = false; }
    await loadSocial();
    selectTab(lastTab);
  }

  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    $("loginError").textContent = "";
    $("loginBtn").disabled = true;
    var res = await db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("loginBtn").disabled = false;
    $("password").value = "";
    if (res.error) {
      var code = res.error.code || "";
      $("loginError").textContent =
        code === "invalid_credentials" ? "Fel e-post eller lösenord." :
        code === "email_not_confirmed" ? "Bekräfta din e-postadress först – kolla inkorgen." :
        res.error.status === 429 ? "För många försök. Vänta några minuter och försök igen." :
        "Det gick inte att logga in. Försök igen.";
      return;
    }
    await signedIn(res.data.user);
  });

  $("logout").addEventListener("click", async function () {
    await db.auth.signOut();
    signedOut();
  });

  // ---------- social graph ----------
  async function loadSocial() {
    var results = await Promise.all([
      db.from("follows").select("following_id").eq("follower_id", me),
      db.from("follow_requests").select("target_id").eq("requester_id", me).eq("status", "pending"),
      db.from("blocked_users").select("blocked_id").eq("blocker_id", me)
    ]);
    following = new Set((results[0].data || []).map(function (r) { return r.following_id; }));
    requested = new Set((results[1].data || []).map(function (r) { return r.target_id; }));
    blocked = new Set((results[2].data || []).map(function (r) { return r.blocked_id; }));
  }

  async function loadProfiles(ids) {
    var missing = ids.filter(function (id) { return !profiles[id]; });
    if (!missing.length) return;
    var res = await db.from("profiles").select("id, username, display_name, avatar_url, is_private").in("id", missing);
    (res.data || []).forEach(function (p) { profiles[p.id] = p; });
  }

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { selectTab(b.dataset.tab); });
  });

  function selectTab(name) {
    lastTab = name;
    document.querySelectorAll(".tab").forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    });
    ["feed", "mine", "riders"].forEach(function (t) { show("tab-" + t, t === name); });
    if (name === "feed") loadFeed();
    if (name === "mine") loadMine();
    if (name === "riders") loadFollowing();
  }

  // ---------- rides ----------
  async function loadFeed() {
    status("Hämtar flödet…");
    var ids = Array.from(following).filter(function (id) { return !blocked.has(id); });
    ids.push(me);
    var res = await db.from("rides").select(RIDE_COLUMNS)
      .in("user_id", ids).neq("visibility", "private")
      .order("started_at", { ascending: false }).limit(50);
    await renderRides($("feedList"), res, "Inga pass än. Följ förare under \"Hitta förare\".");
  }

  async function loadMine() {
    status("Hämtar dina pass…");
    var res = await db.from("rides").select(RIDE_COLUMNS)
      .eq("user_id", me).order("started_at", { ascending: false }).limit(100);
    await renderRides($("mineList"), res, "Du har inga sparade pass än.");
  }

  async function healthFor(rides) {
    if (!rides.length) return {};
    var res = await db.from("ride_health_metrics")
      .select("ride_id, average_heart_rate, max_heart_rate, active_calories")
      .in("ride_id", rides.map(function (r) { return r.id; }));
    var out = {};
    (res.data || []).forEach(function (h) { out[h.ride_id] = h; });
    return out;
  }

  async function renderRides(list, res, emptyText) {
    list.textContent = "";
    if (res.error) { status("Det gick inte att hämta passen. Ladda om sidan och försök igen."); return; }
    var rides = res.data || [];
    status(rides.length ? "" : emptyText);
    await loadProfiles(Array.from(new Set(rides.map(function (r) { return r.user_id; }))));
    var health = await healthFor(rides);
    rides.forEach(function (r) { list.appendChild(rideCard(r, health[r.id])); });
  }

  function rideStats(r, h, box) {
    box.appendChild(stat(duration(r.duration_seconds), "TID"));
    box.appendChild(stat(km(r.distance_meters), "KM"));
    var avg = r.average_speed_kmh != null ? r.average_speed_kmh :
      (r.duration_seconds > 0 ? r.distance_meters / r.duration_seconds * 3.6 : null);
    box.appendChild(stat(whole(avg) + " / " + whole(r.max_speed_kmh), "SNITT/MAX KM/H"));
    if (h && h.max_heart_rate) box.appendChild(stat(whole(h.average_heart_rate) + " / " + whole(h.max_heart_rate), "PULS SNITT/MAX"));
    if (r.ascent_meters) box.appendChild(stat(whole(r.ascent_meters) + " m", "STIGNING"));
  }

  function rideCard(r, h) {
    var p = profiles[r.user_id];
    var card = el("button", "ride"); card.type = "button";
    var head = el("div", "ridehead");
    head.appendChild(avatar(p));
    var who = el("div");
    who.appendChild(el("div", "name", r.user_id === me ? "Du" : displayName(p)));
    var meta = el("div", "meta");
    meta.appendChild(plate(r.activity_type));
    meta.appendChild(document.createTextNode(date(r.started_at)));
    who.appendChild(meta);
    head.appendChild(who);
    card.appendChild(head);
    if (r.title) card.appendChild(el("div", "ridetitle", r.title));
    var stats = el("div", "stats");
    rideStats(r, h, stats);
    card.appendChild(stats);
    card.addEventListener("click", function () { openRide(r, h); });
    return card;
  }

  // ---------- ride detail ----------
  $("back").addEventListener("click", function () {
    show("detail", false); show("app", true);
    window.scrollTo(0, 0);
  });

  async function openRide(r, h) {
    show("app", false); show("detail", true); status("");
    window.scrollTo(0, 0);
    var p = profiles[r.user_id];
    var head = $("detailHead"); head.textContent = "";
    var top = el("div", "ridehead");
    top.appendChild(avatar(p));
    var who = el("div");
    who.appendChild(el("div", "name", r.user_id === me ? "Du" : displayName(p)));
    var meta = el("div", "meta");
    meta.appendChild(plate(r.activity_type));
    meta.appendChild(document.createTextNode(date(r.started_at)));
    who.appendChild(meta);
    top.appendChild(who);
    head.appendChild(top);
    if (r.title) head.appendChild(el("h1", "display h2", r.title));
    if (r.note) head.appendChild(el("p", null, r.note));

    var stats = $("detailStats"); stats.textContent = "";
    rideStats(r, h, stats);
    renderLaps(r);
    await renderMap(r);
  }

  async function fetchRoute(rideId) {
    var points = [], from = 0, size = 1000;
    for (;;) {
      var res = await db.from("ride_routes").select("latitude, longitude")
        .eq("ride_id", rideId).order("sequence_number", { ascending: true })
        .range(from, from + size - 1);
      if (res.error) throw res.error;
      var rows = res.data || [];
      rows.forEach(function (p) { points.push([p.latitude, p.longitude]); });
      if (rows.length < size || points.length > 60000) break;
      from += size;
    }
    return points;
  }

  async function renderMap(r) {
    var note = $("mapNote");
    note.hidden = true;
    if (map) { map.remove(); map = null; }
    show("map", false);
    if (r.user_id !== me && r.share_route === false) {
      note.textContent = "Föraren delar inte kartan för det här passet."; note.hidden = false;
      return;
    }
    var points;
    try { points = await fetchRoute(r.id); } catch (e) { points = []; }
    if (points.length < 2) {
      note.textContent = "Ingen karta för det här passet."; note.hidden = false;
      return;
    }
    show("map", true);
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    var line = L.polyline(points, { color: "#0a1847", weight: 4, opacity: 0.9 }).addTo(map);
    L.circleMarker(points[0], { radius: 6, color: "#1f5c45", fillOpacity: 1 }).addTo(map);
    L.circleMarker(points[points.length - 1], { radius: 6, color: "#b3261e", fillOpacity: 1 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [20, 20] });
    if (r.user_id !== me) {
      note.textContent = "Delar nära förarens privata zoner visas inte."; note.hidden = false;
    }
  }

  async function renderLaps(r) {
    var box = $("detailLaps"); box.textContent = "";
    box.className = "laps";
    // Track laps (tenths): your own rides only (same as the app).
    if (r.user_id === me) {
      var res = await db.from("track_laps")
        .select("id, lap_number, lap_seconds, course_id, course:spot_courses(name), spot:spots(name)")
        .eq("ride_id", r.id).order("started_at", { ascending: true });
      var groups = {}, order = [];
      (res.data || []).forEach(function (l) {
        if (!groups[l.course_id]) { groups[l.course_id] = []; order.push(l.course_id); }
        groups[l.course_id].push(l);
      });
      order.forEach(function (id) {
        var laps = groups[id];
        var first = laps[0];
        var title = [first.spot && first.spot.name, first.course && first.course.name].filter(Boolean).join(" – ");
        lapList(box, title || "Banvarv", laps.map(function (l) {
          return { label: "Varv " + l.lap_number, seconds: l.lap_seconds };
        }), true);
      });
    }
    // Own laps (NEW LAP / auto lap): rides.laps = [{t, d}], t = ride time at lap end.
    var ends = Array.isArray(r.laps) ? r.laps : [];
    if (ends.length > 1) {
      lapList(box, "Varv", ends.map(function (l, i) {
        return { label: "Varv " + (i + 1), seconds: l.t - (i > 0 ? ends[i - 1].t : 0) };
      }), false);
    }
  }

  function lapList(box, title, laps, tenths) {
    box.appendChild(el("h3", null, title));
    var best = laps.length > 1 ? laps.reduce(function (a, b) { return b.seconds < a.seconds ? b : a; }) : null;
    laps.forEach(function (l) {
      var row = el("div", "laprow" + (l === best ? " best" : ""));
      row.appendChild(el("span", null, l.label + (l === best ? " · bäst" : "")));
      row.appendChild(el("span", null, lapTime(l.seconds, tenths)));
      box.appendChild(row);
    });
  }

  // ---------- riders ----------
  $("searchForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    // Letters, digits, space, dot, dash and underscore only (safe in the filter).
    var q = $("searchInput").value.replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
    var list = $("searchList"); list.textContent = "";
    if (q.length < 2) return;
    status("Söker…");
    var res = await db.from("profiles").select("id, username, display_name, avatar_url, is_private")
      .or("username.ilike.%" + q + "%,display_name.ilike.%" + q + "%").limit(25);
    var rows = (res.data || []).filter(function (p) { return p.id !== me && !blocked.has(p.id); });
    status(rows.length ? "" : "Ingen förare hittades.");
    rows.forEach(function (p) { profiles[p.id] = p; list.appendChild(riderRow(p)); });
  });

  async function loadFollowing() {
    var list = $("followingList"); list.textContent = "";
    var ids = Array.from(following);
    if (!ids.length) { list.appendChild(el("p", "muted", "Du följer ingen än. Sök efter förare ovan.")); return; }
    await loadProfiles(ids);
    ids.map(function (id) { return profiles[id]; }).filter(Boolean)
      .sort(function (a, b) { return displayName(a).localeCompare(displayName(b), "sv"); })
      .forEach(function (p) { list.appendChild(riderRow(p)); });
  }

  function riderRow(p) {
    var row = el("div", "rider");
    row.appendChild(avatar(p));
    var mid = el("div", "grow");
    mid.appendChild(el("div", "name", displayName(p)));
    mid.appendChild(el("div", "meta", "@" + p.username + (p.is_private ? " · privat profil" : "")));
    row.appendChild(mid);
    var btn = el("button", "follow"); btn.type = "button";
    function paint() {
      var on = following.has(p.id), req = requested.has(p.id);
      btn.textContent = on ? "Följer" : req ? "Förfrågan skickad" : "Följ";
      btn.classList.toggle("on", on || req);
    }
    paint();
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      var ok = following.has(p.id) || requested.has(p.id) ? await unfollow(p) : await follow(p);
      btn.disabled = false;
      if (!ok) status("Det gick inte. Försök igen.");
      paint();
    });
    row.appendChild(btn);
    return row;
  }

  async function follow(p) {
    if (p.is_private) {
      // Same as the app: reuse an earlier request row, otherwise create one.
      var existing = await db.from("follow_requests").select("status")
        .eq("requester_id", me).eq("target_id", p.id).limit(1);
      if (existing.error) return false;
      var res = existing.data && existing.data.length
        ? await db.from("follow_requests").update({ status: "pending" }).eq("requester_id", me).eq("target_id", p.id)
        : await db.from("follow_requests").insert({ requester_id: me, target_id: p.id, status: "pending" });
      if (res.error) return false;
      requested.add(p.id);
      return true;
    }
    var r = await db.from("follows").upsert({ follower_id: me, following_id: p.id }, { onConflict: "follower_id,following_id" });
    if (r.error) return false;
    following.add(p.id);
    return true;
  }

  async function unfollow(p) {
    var a = await db.from("follows").delete().eq("follower_id", me).eq("following_id", p.id);
    var b = await db.from("follow_requests").delete().eq("requester_id", me).eq("target_id", p.id).eq("status", "pending");
    if (a.error || b.error) return false;
    following.delete(p.id); requested.delete(p.id);
    return true;
  }

  db.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT") signedOut();
  });

  start();
})();
