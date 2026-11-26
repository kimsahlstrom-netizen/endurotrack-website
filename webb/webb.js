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
    ["feed", "mine", "garage", "riders"].forEach(function (t) { show("tab-" + t, t === name); });
    if (name === "feed") loadFeed();
    if (name === "mine") loadMine();
    if (name === "garage") loadGarage();
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

  // ---------- garage (same tables as the app: bikes, bike_services, bike_setups) ----------
  var SERVICE_KINDS = [
    ["oil", "Oljebyte"], ["oil_filter", "Oljefilter"], ["air_filter", "Luftfilter"], ["spark_plug", "Tändstift"],
    ["chain", "Kedja & drev"], ["tyre_front", "Framdäck"], ["tyre_rear", "Bakdäck"], ["tyres", "Båda däcken"],
    ["brakes", "Bromsbelägg"], ["suspension", "Fjädringsservice"], ["piston", "Kolv / topp"], ["valves", "Ventiler"],
    ["coolant", "Kylvätska"], ["other", "Annat"]
  ];
  var SETUP_FIELDS = [
    ["fork_comp", "Gaffel compression", "T.ex. 12 klick ut"], ["fork_reb", "Gaffel retur", "T.ex. 12 klick ut"],
    ["fork_spring", "Gaffel fjäder/luft", "T.ex. 4,6 N/mm"], ["shock_lsc", "Stötdämpare low speed", "T.ex. 12 klick ut"],
    ["shock_hsc", "Stötdämpare high speed", "T.ex. 1,5 varv ut"], ["shock_reb", "Stötdämpare retur", "T.ex. 12 klick ut"],
    ["sag", "Race sag", "T.ex. 105 mm"], ["static_sag", "Statisk sag", "T.ex. 35 mm"],
    ["tyre_front", "Däcktryck fram", "T.ex. 0,9 bar"], ["tyre_rear", "Däcktryck bak", "T.ex. 0,9 bar"]
  ];
  function kindTitle(k) {
    for (var i = 0; i < SERVICE_KINDS.length; i++) if (SERVICE_KINDS[i][0] === k) return SERVICE_KINDS[i][1];
    return k;
  }
  function hoursText(h) { return (Math.round(h * 10) / 10).toLocaleString("sv-SE") + " h"; }
  function money(n) { return Math.round(n).toLocaleString("sv-SE") + " kr"; }
  function num(text) {
    var t = String(text || "").replace(/\s/g, "").replace(",", ".");
    if (!t) return null;
    var n = Number(t);
    return isFinite(n) && n >= 0 ? n : NaN;
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  var garage = { bikes: [], services: {}, setups: {}, rideHours: {} };

  async function fetchAllRides() {
    var rows = [], from = 0, size = 1000;
    for (;;) {
      var res = await db.from("rides").select("id, duration_seconds, activity_type, started_at, bike_id")
        .eq("user_id", me).order("started_at", { ascending: true }).range(from, from + size - 1);
      if (res.error) throw res.error;
      rows = rows.concat(res.data || []);
      if ((res.data || []).length < size) break;
      from += size;
    }
    return rows;
  }

  async function loadGarage() {
    var list = $("garageList");
    status("Hämtar garaget…");
    try {
      var bikes = await db.from("bikes").select("id, name, vehicle, start_hours, created_at")
        .eq("user_id", me).order("created_at", { ascending: true });
      if (bikes.error) throw bikes.error;
      garage.bikes = bikes.data || [];
      garage.services = {}; garage.setups = {}; garage.rideHours = {};
      if (garage.bikes.length) {
        var results = await Promise.all([
          db.from("bike_services").select("id, bike_id, performed_on, hours, kinds, note, cost, photo_paths")
            .eq("user_id", me).order("performed_on", { ascending: false }).order("created_at", { ascending: false }),
          db.from("bike_setups").select("id, bike_id, name, note, " + SETUP_FIELDS.map(function (f) { return f[0]; }).join(", "))
            .eq("user_id", me).order("created_at", { ascending: true }),
          fetchAllRides()
        ]);
        if (results[0].error) throw results[0].error;
        (results[0].data || []).forEach(function (s) { (garage.services[s.bike_id] = garage.services[s.bike_id] || []).push(s); });
        (results[1].data || []).forEach(function (s) { (garage.setups[s.bike_id] = garage.setups[s.bike_id] || []).push(s); });
        // Engine hours, same rule as the app: rides chosen for the bike, plus rides
        // without a bike when it is the only bike of that vehicle type.
        results[2].forEach(function (r) {
          var bike = garage.bikes.find(function (b) { return b.id === r.bike_id; });
          if (!bike && !r.bike_id) {
            var same = garage.bikes.filter(function (b) { return b.vehicle === (r.activity_type || "enduro"); });
            if (same.length === 1 && new Date(r.started_at) >= new Date(same[0].created_at)) bike = same[0];
          }
          if (bike) garage.rideHours[bike.id] = (garage.rideHours[bike.id] || 0) + (r.duration_seconds || 0) / 3600;
        });
      }
      status(garage.bikes.length ? "" : "Du har inga motorcyklar i garaget än. Lägg till dem i appen under Garage.");
      list.textContent = "";
      garage.bikes.forEach(function (b) { list.appendChild(bikeCard(b)); });
    } catch (e) {
      status("Det gick inte att hämta garaget. Ladda om sidan och försök igen.");
    }
  }

  function bikeHours(b) { return (Number(b.start_hours) || 0) + (garage.rideHours[b.id] || 0); }

  function hoursSince(kind, b) {
    var last = (garage.services[b.id] || []).find(function (s) { return (s.kinds || []).indexOf(kind) >= 0; });
    if (!last || last.hours == null) return null;
    return Math.max(0, bikeHours(b) - last.hours);
  }

  function bikeCard(b) {
    var card = el("div", "bike");
    var head = el("div", "bikehead");
    head.appendChild(plate(b.vehicle));
    head.appendChild(el("h2", "display", b.name));
    card.appendChild(head);
    var stats = el("div", "stats");
    stats.appendChild(stat(hoursText(bikeHours(b)), "MOTORTIMMAR"));
    var oil = hoursSince("oil", b);
    if (oil != null) stats.appendChild(stat(hoursText(oil), "SEDAN OLJEBYTE"));
    var services = garage.services[b.id] || [];
    var total = services.reduce(function (a, s) { return a + (Number(s.cost) || 0); }, 0);
    if (total > 0) stats.appendChild(stat(money(total), "KOSTNAD TOTALT"));
    card.appendChild(stats);

    // Service log
    var sec = el("div", "section");
    var sh = el("div", "sectionhead");
    sh.appendChild(el("h3", null, "SERVICELOGG"));
    var add = el("button", "smallbtn solid", "+ Lägg till service"); add.type = "button";
    sh.appendChild(add);
    sec.appendChild(sh);
    var editorSlot = el("div");
    sec.appendChild(editorSlot);
    add.addEventListener("click", function () { serviceEditor(editorSlot, b, null); });
    if (!services.length) sec.appendChild(el("p", "muted small", "Ingen service loggad än."));
    services.forEach(function (s) { sec.appendChild(serviceEntry(b, s)); });
    card.appendChild(sec);

    // Suspension setups
    var sec2 = el("div", "section");
    var sh2 = el("div", "sectionhead");
    sh2.appendChild(el("h3", null, "FJÄDRING – SETUPS"));
    var add2 = el("button", "smallbtn solid", "+ Ny setup"); add2.type = "button";
    sh2.appendChild(add2);
    sec2.appendChild(sh2);
    var setupSlot = el("div");
    sec2.appendChild(setupSlot);
    add2.addEventListener("click", function () { setupEditor(setupSlot, b, null); });
    var setups = garage.setups[b.id] || [];
    if (!setups.length) sec2.appendChild(el("p", "muted small", "Inga sparade setups än."));
    setups.forEach(function (s) { sec2.appendChild(setupEntry(b, s)); });
    card.appendChild(sec2);
    return card;
  }

  function serviceEntry(b, s) {
    var e = el("div", "entry");
    var head = el("div", "entryhead");
    var d = new Date(s.performed_on + "T12:00:00");
    head.appendChild(el("span", null, d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) +
      (s.hours != null ? " · " + hoursText(s.hours) : "")));
    if (s.cost) head.appendChild(el("span", null, money(s.cost)));
    e.appendChild(head);
    if ((s.kinds || []).length) {
      var chips = el("div", "chips");
      s.kinds.forEach(function (k) { chips.appendChild(el("span", "chip", kindTitle(k))); });
      e.appendChild(chips);
    }
    if (s.note) e.appendChild(el("p", null, s.note));
    var paths = s.photo_paths || [];
    if (paths.length) {
      var ph = el("div", "photos");
      e.appendChild(ph);
      db.storage.from("photos").createSignedUrls(paths, 3600).then(function (res) {
        (res.data || []).forEach(function (x) {
          if (!x.signedUrl) return;
          var a = el("a"); a.href = x.signedUrl; a.target = "_blank"; a.rel = "noopener";
          var img = el("img"); img.src = x.signedUrl; img.alt = "Kvitto/bild"; img.loading = "lazy";
          a.appendChild(img); ph.appendChild(a);
        });
      });
    }
    var row = el("div", "row");
    var edit = el("button", "smallbtn", "Ändra"); edit.type = "button";
    var del = el("button", "smallbtn danger", "Ta bort"); del.type = "button";
    row.appendChild(edit); row.appendChild(del);
    e.appendChild(row);
    var slot = el("div"); e.appendChild(slot);
    edit.addEventListener("click", function () { serviceEditor(slot, b, s); });
    del.addEventListener("click", async function () {
      if (!confirm("Ta bort den här servicen? Det går inte att ångra.")) return;
      var r = await db.from("bike_services").delete().eq("id", s.id);
      if (r.error) { alert("Det gick inte att ta bort. Försök igen."); return; }
      if (paths.length) await db.storage.from("photos").remove(paths);
      loadGarage();
    });
    return e;
  }

  function serviceEditor(slot, b, s) {
    slot.textContent = "";
    var f = el("form", "editor");
    var g = el("div", "grid2");
    var date = el("input"); date.type = "date"; date.value = s ? s.performed_on : today(); date.required = true;
    var hours = el("input"); hours.inputMode = "decimal";
    hours.value = s ? (s.hours != null ? String(s.hours).replace(".", ",") : "") : String(Math.round(bikeHours(b) * 10) / 10).replace(".", ",");
    var cost = el("input"); cost.inputMode = "decimal"; cost.value = s && s.cost != null ? String(s.cost).replace(".", ",") : "";
    [["Datum", date], ["Motortimmar", hours], ["Kostnad (kr)", cost]].forEach(function (x) {
      var l = el("label", null, x[0]); l.appendChild(x[1]); g.appendChild(l);
    });
    f.appendChild(g);
    f.appendChild(el("div", "small muted", "Vad gjordes?"));
    var checks = el("div", "checks");
    var boxes = SERVICE_KINDS.map(function (k) {
      var l = el("label"); var c = el("input"); c.type = "checkbox"; c.value = k[0];
      c.checked = !!(s && (s.kinds || []).indexOf(k[0]) >= 0);
      l.appendChild(c); l.appendChild(document.createTextNode(k[1])); checks.appendChild(l);
      return c;
    });
    f.appendChild(checks);
    var nl = el("label", null, "Anteckning (t.ex. däckets namn på första raden)");
    var note = el("textarea"); note.maxLength = 2000; note.value = s && s.note ? s.note : "";
    nl.appendChild(note); f.appendChild(nl);
    if (!s) f.appendChild(el("p", "small muted", "Bilder på kvitton lägger du till i appen."));
    var err = el("p", "error"); f.appendChild(err);
    var row = el("div", "row");
    var save = el("button", "btn btn-gold", "Spara"); save.type = "submit";
    var cancel = el("button", "smallbtn", "Avbryt"); cancel.type = "button";
    row.appendChild(save); row.appendChild(cancel); f.appendChild(row);
    cancel.addEventListener("click", function () { slot.textContent = ""; });
    f.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var h = num(hours.value), c = num(cost.value);
      if (Number.isNaN(h) || Number.isNaN(c)) { err.textContent = "Skriv timmar och kostnad som siffror."; return; }
      var kinds = boxes.filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
      var text = note.value.trim();
      var row = { bike_id: b.id, user_id: me, performed_on: date.value, hours: h, kinds: kinds,
                  note: text ? text.slice(0, 2000) : null, cost: c };
      save.disabled = true;
      var r = s ? await db.from("bike_services").update(row).eq("id", s.id)
                : await db.from("bike_services").insert(Object.assign(row, { photo_paths: [] }));
      save.disabled = false;
      if (r.error) { err.textContent = "Det gick inte att spara. Försök igen."; return; }
      loadGarage();
    });
    slot.appendChild(f);
  }

  function setupEntry(b, s) {
    var e = el("div", "entry");
    var head = el("div", "entryhead");
    head.appendChild(el("span", null, s.name));
    e.appendChild(head);
    var vals = el("div", "setupvals");
    SETUP_FIELDS.forEach(function (f) {
      if (!s[f[0]]) return;
      var d = el("div"); d.appendChild(el("span", null, f[1] + ": ")); d.appendChild(document.createTextNode(s[f[0]]));
      vals.appendChild(d);
    });
    e.appendChild(vals);
    if (s.note) e.appendChild(el("p", null, s.note));
    var row = el("div", "row");
    var edit = el("button", "smallbtn", "Ändra"); edit.type = "button";
    var del = el("button", "smallbtn danger", "Ta bort"); del.type = "button";
    row.appendChild(edit); row.appendChild(del); e.appendChild(row);
    var slot = el("div"); e.appendChild(slot);
    edit.addEventListener("click", function () { setupEditor(slot, b, s); });
    del.addEventListener("click", async function () {
      if (!confirm("Ta bort setupen \"" + s.name + "\"? Det går inte att ångra.")) return;
      var r = await db.from("bike_setups").delete().eq("id", s.id);
      if (r.error) { alert("Det gick inte att ta bort. Försök igen."); return; }
      loadGarage();
    });
    return e;
  }

  function setupEditor(slot, b, s) {
    slot.textContent = "";
    var f = el("form", "editor");
    var nl = el("label", null, "Namn (t.ex. Standard eller SMK Ljungby – blött)");
    var name = el("input"); name.maxLength = 60; name.required = true; name.value = s ? s.name : "";
    nl.appendChild(name); f.appendChild(nl);
    var g = el("div", "grid2");
    var inputs = {};
    SETUP_FIELDS.forEach(function (fd) {
      var l = el("label", null, fd[1]); var i = el("input"); i.maxLength = 30; i.placeholder = fd[2];
      i.value = s && s[fd[0]] ? s[fd[0]] : "";
      inputs[fd[0]] = i; l.appendChild(i); g.appendChild(l);
    });
    f.appendChild(g);
    var notel = el("label", null, "Anteckning");
    var note = el("textarea"); note.maxLength = 2000; note.value = s && s.note ? s.note : "";
    notel.appendChild(note); f.appendChild(notel);
    var err = el("p", "error"); f.appendChild(err);
    var row = el("div", "row");
    var save = el("button", "btn btn-gold", "Spara"); save.type = "submit";
    var cancel = el("button", "smallbtn", "Avbryt"); cancel.type = "button";
    row.appendChild(save); row.appendChild(cancel); f.appendChild(row);
    cancel.addEventListener("click", function () { slot.textContent = ""; });
    f.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      function clean(t, n) { t = (t || "").trim(); return t ? t.slice(0, n) : null; }
      var data = { bike_id: b.id, user_id: me, name: clean(name.value, 60) || "Setup", note: clean(note.value, 2000),
                   updated_at: new Date().toISOString() };
      SETUP_FIELDS.forEach(function (fd) { data[fd[0]] = clean(inputs[fd[0]].value, 30); });
      save.disabled = true;
      var r = s ? await db.from("bike_setups").update(data).eq("id", s.id)
                : await db.from("bike_setups").insert(data);
      save.disabled = false;
      if (r.error) { err.textContent = "Det gick inte att spara. Försök igen."; return; }
      loadGarage();
    });
    slot.appendChild(f);
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
