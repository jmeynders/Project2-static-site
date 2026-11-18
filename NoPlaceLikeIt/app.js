// app.js

const SEARCH_API = "https://data.rijksmuseum.nl/search/collection";
const OBJECT_BASE = "https://id.rijksmuseum.nl";

// Five rooms
const EXHIBITION = {
    "I. The Meadow": {
        desc: "The dream of the local. These works depict the quiet abundance of the countryside, where the land is tamed, fertile, and endlessly peaceful.",
        ids: [
            "https://id.rijksmuseum.nl/200107817", // Distant View of the Meadows
            "https://id.rijksmuseum.nl/200107818"  // The Watercourse near 's-Graveland
        ]
    },
    "II. The Water": {
        desc: "The dream of the horizon. Harbors and rivers promise trade, travel, and escape. Here, water is both a boundary and a doorway to elsewhere.",
        ids: [
            "https://id.rijksmuseum.nl/200107885", // Landschap bij de rivier Senhor
            "https://id.rijksmuseum.nl/20026718",  // Italiaans landschap haven
            "https://id.rijksmuseum.nl/200109446"  // Boat with a Pollard Willow
        ]
    },
    "III. The Town": {
        desc: "The dream of society. From the streets of Paris to distant colonial outposts, these works imagine the bustling ideal of human connection and architecture.",
        ids: [
            "https://id.rijksmuseum.nl/20015957"   // View of the Church of Notre Dame
        ]
    },
    "IV. The Mountain": {
        desc: "The dream of the sublime. The Italian landscapes and dramatic waterfalls here represent nature not as something to be tamed, but as something awe-inspiring.",
        ids: [
            "https://id.rijksmuseum.nl/200108686", // The Cascades at Tivoli
            "https://id.rijksmuseum.nl/200111816"  // The Gulf of Naples
        ]
    },
    "V. The Ruin": {
        desc: "The dream of time. The final room looks at places that have survived disaster or decay, finding a strange beauty in what remains.",
        ids: [
            "https://id.rijksmuseum.nl/200108077", // The water reservoirs near Istanbul
            "https://id.rijksmuseum.nl/200109191"  // Het slot Berkenrode
        ]
    }
};

// ---------- Helpers ----------

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Recursively find the first IIIF image URL inside the Linked Art record
function findImageUrl(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = findImageUrl(item);
            if (found) return found;
        }
        return null;
    }
    // direct hit on access_point
    if (Array.isArray(obj.access_point)) {
        for (const ap of obj.access_point) {
            if (ap && typeof ap.id === "string" && ap.id.includes("iiif.micr.io")) {
                return ap.id;
            }
        }
    }
    // recurse through every key
    for (const key of Object.keys(obj)) {
        const found = findImageUrl(obj[key]);
        if (found) return found;
    }
    return null;
}

// Pull the actual Title (ignoring the Object Number)
function extractLabel(obj) {
    const ids = obj?.identified_by;
    if (!Array.isArray(ids)) return "Untitled";

    // 1. Look for a label explicitly classified as "Title"
    for (const entry of ids) {
        const isTitle = entry?.classified_as?.some(
            (c) => c._label === "Title" || c.id === "http://vocab.getty.edu/aat/300417642"
        );
        if (isTitle && entry.content) return entry.content;
    }

    // 2. Fallback: return the longest string (usually the title, not the object number)
    let longest = "";
    for (const entry of ids) {
        if (typeof entry?.content === "string" && entry.content.length > longest.length) {
            longest = entry.content;
        }
    }
    return longest || "Untitled";
}

// Pull creator name from produced_by.carried_out_by
function extractCreator(obj) {
    const carried = obj?.produced_by?.carried_out_by;
    if (!Array.isArray(carried)) return "Anonymous";
    for (const actor of carried) {
        if (actor?._label) return actor._label;
        const name = extractLabel(actor);
        if (name) return name;
    }
    return "Anonymous";
}

// Pull a date string from produced_by.timespan
function extractDate(obj) {
    const ts = obj?.produced_by?.timespan;
    if (!ts) return "";
    if (typeof ts._label === "string") return ts._label;
    if (typeof ts.begin_of_the_begin === "string") return ts.begin_of_the_begin.slice(0, 10);
    return "";
}

// Pull the place (looks in production AND current location)
function extractPlace(obj) {
    // Check production place
    const producedPlace = obj?.produced_by?.took_place_at;
    if (Array.isArray(producedPlace)) {
        for (const p of producedPlace) {
            if (p?._label) return p._label;
        }
    }
    // Fallback: check current location
    const currentPlace = obj?.current_location;
    if (Array.isArray(currentPlace)) {
        for (const p of currentPlace) {
            if (p?._label) return p._label;
        }
    }
    return "Place unknown";
}

// ---------- Rijksmuseum API ----------

async function searchObjectIds(term, limit = 10) {
    // Dropped 'creator=anonymous' and added 'type=painting'
    const url = `${SEARCH_API}?description=${encodeURIComponent(term)}&type=painting&imageAvailable=true`;
    const res = await fetch(url, { headers: { Accept: "application/ld+json" } });
    if (!res.ok) throw new Error(`Search ${term} failed: ${res.status}`);
    const json = await res.json();
    const items = json.orderedItems || [];
    return items.slice(0, limit).map((it) => it.id);
}

async function resolveObject(id, room) {
    const res = await fetch(id, { headers: { Accept: "application/ld+json" } });
    if (!res.ok) throw new Error(`Resolve ${id} failed: ${res.status}`);
    const obj = await res.json();

    const title = extractLabel(obj) || "Untitled";

    return {
        id,
        room,
        title: title,
        creator: extractCreator(obj),
        date: extractDate(obj),
        place: extractPlace(obj),
        imageUrl: findImageUrl(obj),
        objectUrl: id,
    };
}

// ---------- State ----------

let allWorks = [];
let selectedIds = new Set(JSON.parse(localStorage.getItem("selected") || "[]"));
let activeRoom = null;

// ---------- Rendering ----------

function renderRoomButtons() {
    const container = document.getElementById("room-buttons");
    container.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.textContent = "All rooms";
    allBtn.className = activeRoom === null ? "active" : "";
    allBtn.onclick = () => { activeRoom = null; renderRoomButtons(); renderGallery(); };
    container.appendChild(allBtn);

    Object.keys(EXHIBITION).forEach((room) => {
        const btn = document.createElement("button");
        btn.textContent = room;
        btn.className = activeRoom === room ? "active" : "";
        btn.onclick = () => { activeRoom = room; renderRoomButtons(); renderGallery(); };
        container.appendChild(btn);
    });
}

function cardHtml(w) {
    const isSelected = selectedIds.has(w.id);
    const img = w.imageUrl
        ? `<img src="${w.imageUrl}" alt="${escapeHtml(w.title)}" loading="lazy">`
        : `<div style="height:180px;background:#ddd;display:grid;place-items:center;color:#666">no image</div>`;

    return `
    <article class="card">
      ${img}
      <h3>${escapeHtml(w.title)}</h3>
      <p>${escapeHtml(w.creator)} · ${escapeHtml(w.date)}</p>
      <p>${escapeHtml(w.place)}</p>
      <button data-id="${w.id}" class="${isSelected ? "selected" : ""}">
        ${isSelected ? "✓ Selected" : "+ Select"}
      </button>
    </article>`;
}

function renderGallery() {
    const gallery = document.getElementById("gallery");
    const works = activeRoom ? allWorks.filter((w) => w.room === activeRoom) : allWorks;

    if (works.length === 0) {
        gallery.innerHTML = "<p>No works loaded.</p>";
        return;
    }

    let headerHtml = "";
    if (activeRoom && EXHIBITION[activeRoom]) {
        headerHtml = `<div style="grid-column: 1 / -1; margin-bottom: 1rem; font-style: italic; color: #444; border-left: 3px solid #333; padding-left: 1rem;">
            ${escapeHtml(EXHIBITION[activeRoom].desc)}
        </div>`;
    }

    gallery.innerHTML = headerHtml + works.map(cardHtml).join("");

    gallery.querySelectorAll("button[data-id]").forEach((btn) => {
        btn.onclick = () => toggleSelection(btn.dataset.id);
    });
}

function renderSelected() {
    const grid = document.getElementById("selected-grid");
    const count = document.getElementById("selected-count");
    const chosen = allWorks.filter((w) => selectedIds.has(w.id));

    count.textContent = `${chosen.length} work${chosen.length === 1 ? "" : "s"} selected`;

    grid.innerHTML = chosen.map((w) => `
    <article class="card">
      ${w.imageUrl ? `<img src="${w.imageUrl}" alt="${escapeHtml(w.title)}">` : ""}
      <h3>${escapeHtml(w.title)}</h3>
      <p>${escapeHtml(w.creator)}</p>
      <button data-id="${w.id}">Remove</button>
    </article>`).join("");

    grid.querySelectorAll("button[data-id]").forEach((btn) => {
        btn.onclick = () => toggleSelection(btn.dataset.id);
    });
}

// ---------- Selection ----------

function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    localStorage.setItem("selected", JSON.stringify([...selectedIds]));
    renderGallery();
    renderSelected();
}

// ---------- Boot ----------

async function boot() {
    renderRoomButtons();
    renderGallery();

    try {
        const results = [];

        // Loop through your specific exhibition
        for (const [room, data] of Object.entries(EXHIBITION)) {
            // Resolve only the IDs you provided
            const resolved = await Promise.all(
                data.ids.map((id) => resolveObject(id, room).catch((e) => {
                    console.warn("Could not load", id, e.message);
                    return null;
                }))
            );
            results.push(...resolved.filter(Boolean));
        }

        allWorks = results;
        console.log(`Loaded ${allWorks.length} curated works`, allWorks);

        renderGallery();
        renderSelected();
    } catch (err) {
        console.error(err);
        document.getElementById("gallery").innerHTML =
            `<p style="color:#b00">Could not load works: ${escapeHtml(err.message)}</p>`;
    }
}

document.getElementById("clear-selection").onclick = () => {
    selectedIds.clear();
    localStorage.removeItem("selected");
    renderGallery();
    renderSelected();
};

boot();