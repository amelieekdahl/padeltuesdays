const STORAGE_KEY = 'padel-tuesdays';
const SHEETS_API = 'https://script.google.com/macros/s/AKfycbzUx9fK6HddJj8qd8OXSOWqhQaJS9nSDBfh9c3AVGyst6ExS_fgXf-H1gh_ipxCVgfp/exec';

const SEASON_START = new Date('2026-01-06T00:00:00'); // First Tuesday — Week 2
const TOTAL_WEEKS = 26; // Jan 6 (week 2) through Jun 30 (week 27)

// Cache for loaded data to avoid constant fetches
let _cachedData = null;
let _dataLoaded = false;

const DEFAULT_DATA = {
    groupA: [],
    groupB: [],
    subs: [],
    weeks: [],
    pairingHistory: [],
    nextWeekRoster: null,
    playlists: []
};

function loadData() {
    // Return cached data if available, otherwise return from localStorage as fallback
    if (_cachedData) return _cachedData;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

let _saveTimer = null;   // debounce timer
let _saving = false;     // is a save in progress?
let _pendingSave = null; // latest data waiting to be saved

function saveData(data) {
    // Save to localStorage immediately (fast)
    _cachedData = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    // Debounce cloud saves: wait 500ms for rapid changes to settle,
    // then send a single save. If a save is in progress, queue it.
    _pendingSave = JSON.parse(JSON.stringify(data)); // deep clone
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _doCloudSave(), 500);
}

async function _doCloudSave() {
    if (_saving) return; // will be picked up after current save finishes
    if (!_pendingSave) return;

    _saving = true;
    const dataToSave = _pendingSave;
    _pendingSave = null;
    updateSyncIndicator('saving');

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            // Strategy: POST via a temporary <form> targeting a hidden iframe.
            // Apps Script redirects POST to a different origin, which blocks
            // fetch even with redirect:follow. The form submission follows
            // redirects natively (no CORS issues).
            await new Promise((resolve) => {
                const iframeName = '_cloud_save_' + Date.now();
                const iframe = document.createElement('iframe');
                iframe.name = iframeName;
                iframe.style.display = 'none';
                document.body.appendChild(iframe);

                const form = document.createElement('form');
                form.method = 'POST';
                form.action = SHEETS_API;
                form.target = iframeName;
                form.style.display = 'none';

                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'payload';
                input.value = JSON.stringify(dataToSave);
                form.appendChild(input);

                document.body.appendChild(form);
                form.submit();

                // Clean up after a delay and resolve
                setTimeout(() => {
                    try { document.body.removeChild(iframe); } catch(_){}
                    try { document.body.removeChild(form); } catch(_){}
                    resolve();
                }, 3000);
            });

            // Verify by reading back (with cache-busting)
            await new Promise(r => setTimeout(r, 1500 + attempt * 2000));
            const verify = await fetch(SHEETS_API + '?_t=' + Date.now(), { cache: 'no-store' });
            const cloudData = await verify.json();

            if (cloudData && cloudData.weeks !== undefined &&
                cloudData.weeks.length === dataToSave.weeks.length) {
                const localLatest = JSON.stringify(dataToSave.weeks[dataToSave.weeks.length - 1] || null);
                const cloudLatest = JSON.stringify(cloudData.weeks[cloudData.weeks.length - 1] || null);
                if (localLatest === cloudLatest) {
                    success = true;
                    break;
                }
            }
            console.warn(`Cloud verify mismatch (attempt ${attempt + 1}), retrying full save...`);
        } catch (e) {
            console.warn(`Cloud save error (attempt ${attempt + 1}):`, e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    _saving = false;
    updateSyncIndicator(success ? 'saved' : 'error');

    // If more saves came in while we were saving, flush them now
    if (_pendingSave) _doCloudSave();
}

async function loadFromCloud() {
    updateSyncIndicator('loading');
    try {
        // Cache-bust to get fresh data
        const res = await fetch(SHEETS_API + '?_t=' + Date.now(), { cache: 'no-store' });
        const text = await res.text();
        // Handle chunked or empty responses
        if (!text || text.trim() === '' || text.trim() === '{}') {
            console.warn('Cloud returned empty data, using localStorage');
            _dataLoaded = true;
            updateSyncIndicator('offline');
            return loadData();
        }
        const data = JSON.parse(text);
        if (data && data.groupA !== undefined) {
            // Cloud data wins — overwrite localStorage
            _cachedData = data;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            _dataLoaded = true;
            updateSyncIndicator('saved');
            return data;
        }
    } catch (e) {
        console.warn('Cloud load failed, using localStorage:', e);
    }
    _dataLoaded = true;
    updateSyncIndicator('offline');
    return loadData();
}

function updateSyncIndicator(state) {
    let el = document.getElementById('syncIndicator');
    if (!el) return;
    const states = {
        loading: { icon: '☁️', text: 'Loading...', color: 'var(--blue)' },
        saving:  { icon: '💾', text: 'Saving...', color: 'var(--accent)' },
        saved:   { icon: '✅', text: 'Synced', color: 'var(--green)' },
        error:   { icon: '⚠️', text: 'Sync failed', color: 'var(--red)' },
        offline: { icon: '📴', text: 'Offline — local only', color: 'var(--orange)' }
    };
    const s = states[state] || states.saved;
    el.innerHTML = `<span style="color:${s.color}">${s.icon} ${s.text}</span>`;

    // Auto-hide "Synced" after 3 seconds
    if (state === 'saved') {
        setTimeout(() => {
            if (el.textContent.includes('Synced')) el.innerHTML = '';
        }, 3000);
    }
}

// Also save to cloud when the user leaves the page (last chance)
window.addEventListener('beforeunload', () => {
    const data = loadData();
    if (data && data.groupA) {
        // navigator.sendBeacon works even during page unload
        navigator.sendBeacon(SHEETS_API, JSON.stringify(data));
    }
});

// Load from cloud on page load, THEN init (to avoid overwriting cloud data)
loadFromCloud().then(data => {
    _cachedData = data;
    _dataLoaded = true;
    init();
    // Force re-render the active section to show fresh cloud data
    populateWeekSelect();
    loadWeek();
    updateSeasonBar();
    updateLeaderboard();
});

// Get all known players across all groups
function getAllPlayers(data) {
    const all = new Set([...data.groupA, ...data.groupB, ...data.subs]);
    // Also include players from completed weeks (in case they were removed from rosters)
    for (const week of data.weeks) {
        if (!week.firstHalf) continue;
        for (const courtKey of Object.keys(week.firstHalf)) {
            const court = week.firstHalf[courtKey];
            if (court.teamA) court.teamA.forEach(p => all.add(p));
            if (court.teamB) court.teamB.forEach(p => all.add(p));
        }
        if (week.secondHalf) {
            for (const courtKey of Object.keys(week.secondHalf)) {
                const court = week.secondHalf[courtKey];
                if (court.teamA) court.teamA.forEach(p => all.add(p));
                if (court.teamB) court.teamB.forEach(p => all.add(p));
            }
        }
    }
    return [...all];
}

// Figure out which group's turn it is for the next week
function getNextWeekNumber(data) {
    return data.weeks.length + 1;
}

function getDefaultGroupForWeek(weekNum) {
    // Odd weeks = Group A, Even weeks = Group B
    return weekNum % 2 === 1 ? 'A' : 'B';
}

function getWeekDate(weekNum) {
    const d = new Date(SEASON_START);
    d.setDate(d.getDate() + (weekNum - 1) * 7);
    return d;
}

function formatDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
}

// ==================== ROSTER MANAGEMENT ====================
function renderRosters() {
    const data = loadData();
    renderGroup(data.groupA, 'groupAGrid', 'A');
    renderGroup(data.groupB, 'groupBGrid', 'B');
    renderGroup(data.subs, 'subGrid', 'sub');
}

function renderGroup(players, gridId, group) {
    const grid = document.getElementById(gridId);
    if (players.length === 0) {
        grid.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem;">No players yet.</div>';
        return;
    }
    grid.innerHTML = players.map((p, i) => `
        <div class="player-chip">
            <div class="avatar ${group === 'A' ? 'group-a' : group === 'B' ? 'group-b' : 'sub'}">${getInitials(p)}</div>
            <span class="name">${p}</span>
            <span class="remove" onclick="removeRosterPlayer('${group}', ${i})">✕</span>
        </div>
    `).join('');
}

function getInitials(name) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function addRosterPlayer(group) {
    const inputId = group === 'A' ? 'newPlayerA' : group === 'B' ? 'newPlayerB' : 'newPlayerSub';
    const input = document.getElementById(inputId);
    const name = input.value.trim();
    if (!name) return;

    const data = loadData();
    const targetList = group === 'A' ? data.groupA : group === 'B' ? data.groupB : data.subs;
    const allPlayers = [...data.groupA, ...data.groupB, ...data.subs];

    if (allPlayers.includes(name)) {
        showToast('Player already exists!');
        return;
    }
    if (group !== 'sub' && targetList.length >= 8) {
        showToast('Maximum 8 players per group!');
        return;
    }

    targetList.push(name);
    saveData(data);
    input.value = '';
    renderRosters();
    showToast(`${name} added! 🎾`);
}

function removeRosterPlayer(group, index) {
    const data = loadData();
    const targetList = group === 'A' ? data.groupA : group === 'B' ? data.groupB : data.subs;
    const name = targetList[index];
    if (data.weeks.length > 0) {
        if (!confirm(`Remove ${name}? They'll still appear in past match history.`)) return;
    }
    targetList.splice(index, 1);
    saveData(data);
    renderRosters();
    showToast(`${name} removed`);
}

// ==================== NEXT WEEK PLANNER ====================
function renderNextWeek() {
    const data = loadData();
    const weekNum = getNextWeekNumber(data);
    const weekDate = getWeekDate(weekNum);
    const defaultGroup = getDefaultGroupForWeek(weekNum);
    const groupLabel = defaultGroup === 'A' ? '🔵 Group A' : '🟣 Group B';
    const defaultPlayers = defaultGroup === 'A' ? data.groupA : data.groupB;

    // Track which group this roster was built for
    const expectedGroup = defaultGroup;
    if (!data.nextWeekRoster || data.nextWeekRoster.length === 0 || data._nextWeekGroup !== expectedGroup) {
        data.nextWeekRoster = [...defaultPlayers];
        data._nextWeekGroup = expectedGroup;
        saveData(data);
    }

    // Playlist selection
    const playlists = data.playlists || [];
    const defaultPlaylistIdx = playlists.length > 0 ? (weekNum - 1) % playlists.length : -1;
    if (data.nextWeekPlaylistIndex === undefined || data.nextWeekPlaylistIndex === null) {
        data.nextWeekPlaylistIndex = defaultPlaylistIdx;
        saveData(data);
    }

    const info = document.getElementById('nextWeekInfo');
    let playlistSelectorHtml = '';
    if (playlists.length > 0) {
        const selectedIdx = data.nextWeekPlaylistIndex !== null ? data.nextWeekPlaylistIndex : defaultPlaylistIdx;
        const selectedId = playlists[selectedIdx] ? playlists[selectedIdx].split(':').pop() : '';
        playlistSelectorHtml = `
            <div style="margin-bottom: 1rem;">
                <label style="font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 0.5rem; color: #1DB954;">
                    🎵 Week's Playlist
                </label>
                <select onchange="updateNextWeekPlaylist(parseInt(this.value))" style="width: 100%; padding: 0.6rem 1rem; margin-bottom: 0.75rem;">
                    ${playlists.map((uri, i) => {
                        const sel = i === selectedIdx ? 'selected' : '';
                        return `<option value="${i}" ${sel}>Playlist #${i + 1} ${i === defaultPlaylistIdx ? '(default rotation)' : ''}</option>`;
                    }).join('')}
                </select>
                ${selectedId ? `<iframe
                    src="https://open.spotify.com/embed/playlist/${selectedId}?utm_source=generator&theme=0"
                    height="80"
                    style="border-radius: 8px; width: 100%; border: none;"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    loading="lazy"></iframe>` : ''}
            </div>`;
    }

    info.innerHTML = `
        <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
            <span style="font-weight: 700; font-size: 1.1rem;">Week ${weekNum}</span>
            <span style="color: var(--text-muted);">📆 ${formatDate(weekDate)}</span>
            <span class="group-indicator group-${defaultGroup.toLowerCase()}">${groupLabel}'s turn</span>
        </div>
        <div class="info-box info" style="margin-bottom: 1rem;">
            The roster below is auto-filled from ${groupLabel}. Swap any player using the dropdowns — great for when someone's ill and needs a sub. You can also pick <strong>"✏️ Type a name..."</strong> to add a fill-in player who isn't in the rotation. Fill-ins will appear on the leaderboard but won't be part of the regular groups. You need exactly 8 players to generate matches.
        </div>
        ${playlistSelectorHtml}
    `;

    const roster = data.nextWeekRoster;
    const allAvailable = [...new Set([...data.groupA, ...data.groupB, ...data.subs])];
    const rosterDiv = document.getElementById('nextWeekRoster');

    // Build 8 slots
    let html = '';
    const allKnownPlayers = [...new Set([...data.groupA, ...data.groupB, ...data.subs])];

    for (let i = 0; i < 8; i++) {
        const current = roster[i] || '';
        const isSub = current && !defaultPlayers.includes(current);
        const isAdHoc = current && !allKnownPlayers.includes(current);

        html += `<div class="roster-slot ${isSub ? 'is-sub' : ''} ${isAdHoc ? 'is-adhoc' : ''}">
            <div class="slot-number">${i + 1}</div>
            <select onchange="updateRosterSlot(${i}, this.value)" ${isAdHoc ? 'style="display:none"' : ''}>
                <option value="">— empty —</option>`;

        // Group options first (the default group)
        html += `<optgroup label="${groupLabel}">`;
        for (const p of defaultPlayers) {
            const sel = p === current ? 'selected' : '';
            const inUse = p !== current && roster.includes(p) ? ' (already in)' : '';
            html += `<option value="${p}" ${sel} ${inUse ? 'disabled' : ''}>${p}${inUse}</option>`;
        }
        html += '</optgroup>';

        // Other group players (not already in the default group)
        const otherGroup = defaultGroup === 'A' ? data.groupB : data.groupA;
        const otherLabel = defaultGroup === 'A' ? 'Group B' : 'Group A';
        const otherGroupOnly = [...new Set(otherGroup)].filter(p => !defaultPlayers.includes(p));

        if (otherGroupOnly.length > 0) {
            html += `<optgroup label="${otherLabel}">`;
            for (const p of otherGroupOnly) {
                const sel = p === current ? 'selected' : '';
                const inUse = p !== current && roster.includes(p) ? ' (already in)' : '';
                html += `<option value="${p}" ${sel} ${inUse ? 'disabled' : ''}>${p}${inUse}</option>`;
            }
            html += '</optgroup>';
        }

        // Subs
        const subOnly = data.subs.filter(p => !defaultPlayers.includes(p) && !otherGroupOnly.includes(p));
        if (subOnly.length > 0) {
            html += `<optgroup label="Subs">`;
            for (const p of subOnly) {
                const sel = p === current ? 'selected' : '';
                const inUse = p !== current && roster.includes(p) ? ' (already in)' : '';
                html += `<option value="${p}" ${sel} ${inUse ? 'disabled' : ''}>${p}${inUse}</option>`;
            }
            html += '</optgroup>';
        }

        // Special option to trigger ad-hoc name entry
        html += `<optgroup label="Other">`;
        html += `<option value="__adhoc__">✏️ Type a name...</option>`;
        html += `</optgroup>`;

        html += `</select>`;

        // Ad-hoc name input (shown when a typed-in name is active)
        if (isAdHoc) {
            html += `<div class="adhoc-input-wrap" style="display:flex;flex:1;gap:0.4rem;align-items:center;">
                <input type="text" class="adhoc-name-input" value="${current}" placeholder="Fill-in name..."
                    onchange="updateRosterSlot(${i}, this.value)"
                    onkeypress="if(event.key==='Enter'){this.blur()}"
                    style="flex:1;padding:0.4rem 0.6rem;font-size:0.85rem;">
                <button class="btn btn-secondary" onclick="clearAdHocSlot(${i})" style="padding:0.3rem 0.6rem;font-size:0.75rem;" title="Switch back to dropdown">✕</button>
            </div>`;
        }

        html += `<span class="sub-badge">${isAdHoc ? 'FILL-IN' : 'SUB'}</span>
        </div>`;
    }

    const filledCount = roster.filter(p => p && p !== '').length;
    html += `<div style="margin-top: 0.75rem; font-size: 0.85rem; color: ${filledCount === 8 ? 'var(--green)' : 'var(--red)'};">
        ${filledCount}/8 players selected ${filledCount === 8 ? '✅' : '— need ' + (8 - filledCount) + ' more'}
    </div>`;

    rosterDiv.innerHTML = html;
}

function updateNextWeekPlaylist(index) {
    const data = loadData();
    data.nextWeekPlaylistIndex = index;
    saveData(data);
    renderNextWeek();
}

function updateRosterSlot(index, value) {
    const data = loadData();
    if (!data.nextWeekRoster) data.nextWeekRoster = [];
    // Ensure array has 8 slots
    while (data.nextWeekRoster.length < 8) data.nextWeekRoster.push('');

    if (value === '__adhoc__') {
        // Prompt for an ad-hoc fill-in name
        const name = prompt('Enter the fill-in player\'s name:');
        if (!name || !name.trim()) {
            // Cancelled — revert to empty
            data.nextWeekRoster[index] = '';
            saveData(data);
            renderNextWeek();
            return;
        }
        data.nextWeekRoster[index] = name.trim();
    } else {
        data.nextWeekRoster[index] = value;
    }

    saveData(data);
    renderNextWeek();
}

function clearAdHocSlot(index) {
    const data = loadData();
    if (!data.nextWeekRoster) data.nextWeekRoster = [];
    while (data.nextWeekRoster.length < 8) data.nextWeekRoster.push('');
    data.nextWeekRoster[index] = '';
    saveData(data);
    renderNextWeek();
}

function resetNextWeekToDefault() {
    const data = loadData();
    const weekNum = getNextWeekNumber(data);
    const defaultGroup = getDefaultGroupForWeek(weekNum);
    data.nextWeekRoster = [...(defaultGroup === 'A' ? data.groupA : data.groupB)];
    data._nextWeekGroup = defaultGroup;
    data.nextWeekPlaylistIndex = null; // reset playlist to default rotation
    saveData(data);
    renderNextWeek();
    showToast('Roster reset to default! 🔄');
}

function confirmAndGenerate() {
    const data = loadData();
    const roster = (data.nextWeekRoster || []).filter(p => p && p !== '');

    if (roster.length !== 8) {
        showToast(`Need exactly 8 players (have ${roster.length})`);
        return;
    }

    if (data.weeks.length >= TOTAL_WEEKS) {
        showToast('Season complete! 🏆');
        return;
    }

    // Use the roster as the active players for this week
    const pairs = generatePairings(roster, data.pairingHistory);
    const courts = assignCourts(pairs);

    for (const pair of pairs) {
        data.pairingHistory.push(pair);
    }

    const weekNum = data.weeks.length + 1;
    const weekDate = getWeekDate(weekNum);
    const defaultGroup = getDefaultGroupForWeek(weekNum);
    const defaultPlayers = defaultGroup === 'A' ? data.groupA : data.groupB;

    // Track which players are subs
    const subNames = roster.filter(p => !defaultPlayers.includes(p));

    const playlists = (data.playlists && data.playlists.length > 0) ? data.playlists : [];
    const selectedPlaylistIdx = data.nextWeekPlaylistIndex !== undefined && data.nextWeekPlaylistIndex !== null
        ? data.nextWeekPlaylistIndex
        : (playlists.length > 0 ? (weekNum - 1) % playlists.length : -1);
    const playlistUri = playlists.length > 0 && selectedPlaylistIdx >= 0 ? playlists[selectedPlaylistIdx] : null;

    const week = {
        number: weekNum,
        date: weekDate.toISOString().split('T')[0],
        group: defaultGroup,
        roster: [...roster],
        subs: subNames,
        playlistUri: playlistUri,
        firstHalf: {
            court1: {
                teamA: courts.court1.teamA,
                teamB: courts.court1.teamB,
                scoreA: null,
                scoreB: null
            },
            court2: {
                teamA: courts.court2.teamA,
                teamB: courts.court2.teamB,
                scoreA: null,
                scoreB: null
            }
        },
        secondHalf: null,
        completed: false
    };

    data.weeks.push(week);
    data.nextWeekRoster = null; // reset for next time
    data._nextWeekGroup = null; // reset group tracking
    data.nextWeekPlaylistIndex = null; // reset playlist selection for next time
    saveData(data);

    // Switch to match day view
    showSection('matchday');
    populateWeekSelect();
    document.getElementById('weekSelect').value = weekNum - 1;
    loadWeek();
    updateSeasonBar();
    showToast(`Week ${weekNum} generated! 🎲`);
}

// ==================== PAIRING ALGORITHM ====================
function generatePairings(players, pairingHistory) {
    // Shuffle players first for randomness — ensures different results each time
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    // Build pair count map for this week's players
    const pairCount = {};
    for (const p of shuffled) {
        for (const q of shuffled) {
            if (p < q) pairCount[p + '|' + q] = 0;
        }
    }
    for (const [a, b] of pairingHistory) {
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (pairCount[key] !== undefined) pairCount[key]++;
    }

    // For each player, find the minimum times they've been paired with
    // any of the other players this week. A pairing is only "fair" if
    // both players in the pair have their count at the global minimum
    // for that player — i.e., they haven't played together yet in the
    // current round-robin cycle.
    //
    // playerMin[p] = the fewest times p has been paired with any of
    // this week's other players. A pair (p, q) with count > min(p) AND
    // count > min(q) means both p and q have un-played partners left,
    // so pairing them is unfair.

    const playerMin = {};
    for (const p of shuffled) {
        let min = Infinity;
        for (const q of shuffled) {
            if (p === q) continue;
            const key = p < q ? p + '|' + q : q + '|' + p;
            min = Math.min(min, pairCount[key] || 0);
        }
        playerMin[p] = min;
    }

    // Collect ALL optimal pairings (tied for best score), then pick one randomly
    let bestPairings = [];
    let bestScore = Infinity;

    function scorePairing(pairs) {
        let violations = 0;   // pairs where both players have cheaper options
        let maxCount = 0;
        let totalCount = 0;

        for (const [a, b] of pairs) {
            const key = a < b ? a + '|' + b : b + '|' + a;
            const count = pairCount[key] || 0;

            // A violation: this pair has played together more than
            // the minimum for BOTH players — meaning both have
            // partners they haven't played with yet (or played less)
            if (count > playerMin[a] && count > playerMin[b]) {
                violations++;
            }

            maxCount = Math.max(maxCount, count);
            totalCount += count;
        }

        // Priority: fewest violations >>> lowest max count >>> lowest total
        return violations * 1000000 + maxCount * 1000 + totalCount;
    }

    function findMatchings(remaining, current) {
        if (remaining.length === 0) {
            const score = scorePairing(current);
            if (score < bestScore) {
                bestScore = score;
                bestPairings = [[...current]];
            } else if (score === bestScore) {
                bestPairings.push([...current]);
            }
            return;
        }

        const first = remaining[0];
        const rest = remaining.slice(1);

        // Sort candidates: prefer partners this player has played with least
        // Add random tiebreaker so same-count partners aren't always in the same order
        const candidates = rest.map((partner, i) => {
            const key = first < partner ? first + '|' + partner : partner + '|' + first;
            return { partner, i, count: pairCount[key] || 0, rand: Math.random() };
        }).sort((a, b) => a.count - b.count || a.rand - b.rand);

        for (const { partner, i } of candidates) {
            const newRemaining = rest.filter((_, j) => j !== i);
            current.push([first, partner]);
            findMatchings(newRemaining, current);
            current.pop();
        }
    }

    findMatchings(shuffled, []);

    // Pick a random optimal pairing
    return bestPairings[Math.floor(Math.random() * bestPairings.length)];
}

function assignCourts(pairs) {
    const shuffled = [...pairs].sort(() => Math.random() - 0.5);
    return {
        court1: { teamA: shuffled[0], teamB: shuffled[1] },
        court2: { teamA: shuffled[2], teamB: shuffled[3] }
    };
}

// ==================== MATCH DISPLAY ====================
function loadWeek() {
    const data = loadData();
    const select = document.getElementById('weekSelect');
    const weekIndex = parseInt(select.value);
    if (isNaN(weekIndex) || !data.weeks[weekIndex]) {
        document.getElementById('matchDisplay').innerHTML = `
            <div class="empty-state">
                <div class="emoji">🎾</div>
                <p>No matches generated yet.</p>
                <p>Go to <strong>Next Week</strong> to plan and generate!</p>
            </div>`;
        return;
    }

    const week = data.weeks[weekIndex];
    let html = '';

    // Week info bar
    const groupLabel = week.group === 'A' ? '🔵 Group A' : '🟣 Group B';
    html += `<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap;">
        <span class="group-indicator group-${(week.group || 'a').toLowerCase()}">${groupLabel}</span>`;
    if (week.subs && week.subs.length > 0) {
        html += `<span style="font-size:0.8rem;color:var(--orange);">🟠 Subs: ${week.subs.join(', ')}</span>`;
    }
    html += '</div>';

    // First Half
    html += '<h3>First Half — 45 minutes</h3>';
    html += '<div class="courts-grid">';
    html += renderCourt(week.firstHalf.court1, 'Court 1', 'court-1', weekIndex, 'firstHalf', 'court1');
    html += renderCourt(week.firstHalf.court2, 'Court 2', 'court-2', weekIndex, 'firstHalf', 'court2');
    html += '</div>';

    // Second Half
    if (week.secondHalf) {
        html += '<div class="second-half-header"><h3>⚡ Second Half — Winners vs Winners</h3><p>The battle for glory!</p></div>';
        html += '<div class="courts-grid">';
        html += renderCourt(week.secondHalf.winners, '🏆 Winners Court', 'winner-court', weekIndex, 'secondHalf', 'winners');
        html += renderCourt(week.secondHalf.losers, 'Consolation Court', 'court-2', weekIndex, 'secondHalf', 'losers');
        html += '</div>';
    }

    // Action buttons
    html += '<div style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem;">';
    if (!week.secondHalf && hasFirstHalfScores(week)) {
        html += '<button class="btn btn-primary" onclick="setupSecondHalf(' + weekIndex + ')">⚡ Set Up Second Half</button>';
    }
    if (week.secondHalf && hasSecondHalfScores(week) && !week.completed) {
        html += '<button class="btn btn-success" onclick="completeWeek(' + weekIndex + ')">✅ Complete Week</button>';
    }
    if (week.completed) {
        html += '<span style="color: var(--green); font-weight: 600;">✅ Week completed!</span>';
        html += ' <button class="btn btn-secondary" style="margin-left:0.5rem;padding:0.3rem 0.8rem;font-size:0.8rem;" onclick="reopenWeek(' + weekIndex + ')">🔓 Reopen</button>';
    }
    html += '</div>';

    // Spotify
    if (week.playlistUri) {
        const playlistId = week.playlistUri.split(':').pop();
        html += `
            <div class="spotify-card">
                <h3>🎵 This Week's Soundtrack</h3>
                <iframe
                    src="https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0"
                    height="152"
                    frameBorder="0"
                    allowfullscreen=""
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    loading="lazy">
                </iframe>
            </div>`;
    }

    document.getElementById('matchDisplay').innerHTML = html;
}

function renderCourt(court, label, cssClass, weekIndex, half, courtKey) {
    const data = loadData();
    const week = data.weeks[weekIndex];
    const nameA = court.teamA.join(' & ');
    const nameB = court.teamB.join(' & ');
    const scoreA = court.scoreA !== null ? court.scoreA : '';
    const scoreB = court.scoreB !== null ? court.scoreB : '';
    const canShuffle = !week.completed && half === 'firstHalf' && !week.secondHalf;

    return `
        <div class="court-card ${cssClass}">
            <div class="court-label" style="display:flex;justify-content:space-between;align-items:center;">
                <span>${label}</span>
                ${canShuffle ? `<button class="btn btn-secondary" style="padding:0.15rem 0.5rem;font-size:0.7rem;" onclick="showSwapModal(${weekIndex}, '${courtKey}')" title="Re-pair players on this court">🔀 Swap</button>` : ''}
            </div>
            <div class="matchup">
                <div class="team">
                    <div class="team-names">${nameA}</div>
                    <input type="number" class="score-input" value="${scoreA}" min="0"
                        onchange="updateScore(${weekIndex}, '${half}', '${courtKey}', 'scoreA', this.value)">
                </div>
                <div class="vs">VS</div>
                <div class="team">
                    <div class="team-names">${nameB}</div>
                    <input type="number" class="score-input" value="${scoreB}" min="0"
                        onchange="updateScore(${weekIndex}, '${half}', '${courtKey}', 'scoreB', this.value)">
                </div>
            </div>
        </div>`;
}

function updateScore(weekIndex, half, courtKey, scoreKey, value) {
    const data = loadData();
    const val = value === '' ? null : parseInt(value);
    data.weeks[weekIndex][half][courtKey][scoreKey] = val;
    saveData(data);
    loadWeek();
}

// ==================== SWAP PLAYERS ====================
let swapState = { weekIndex: null, courtKey: null };

function showSwapModal(weekIndex, courtKey) {
    const data = loadData();
    const week = data.weeks[weekIndex];
    const court = week.firstHalf[courtKey];
    const otherCourtKey = courtKey === 'court1' ? 'court2' : 'court1';
    const otherCourt = week.firstHalf[otherCourtKey];

    swapState = { weekIndex, courtKey };

    // All 8 players across both courts
    const allPlayers = [...court.teamA, ...court.teamB, ...otherCourt.teamA, ...otherCourt.teamB];

    // Build swap options: pick any player from this court to swap with any player from either court
    const courtLabel = courtKey === 'court1' ? 'Court 1' : 'Court 2';
    const otherLabel = courtKey === 'court1' ? 'Court 2' : 'Court 1';
    const thisCourtPlayers = [...court.teamA, ...court.teamB];
    const otherCourtPlayers = [...otherCourt.teamA, ...otherCourt.teamB];

    let html = `
        <div style="margin-bottom:1rem;">
            <label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:0.4rem;">Player from ${courtLabel}:</label>
            <select id="swapPlayerA" style="width:100%;" onchange="updateSwapPreview()">
                ${thisCourtPlayers.map(p => `<option value="${p}">${p}</option>`).join('')}
            </select>
        </div>
        <div style="text-align:center;font-size:1.2rem;margin:0.5rem 0;">🔄</div>
        <div style="margin-bottom:1rem;">
            <label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:0.4rem;">Swap with:</label>
            <select id="swapPlayerB" style="width:100%;" onchange="updateSwapPreview()">
                <optgroup label="Same court (${courtLabel}) — re-pair">
                    ${thisCourtPlayers.map(p => `<option value="${p}">${p}</option>`).join('')}
                </optgroup>
                <optgroup label="Other court (${otherLabel}) — swap across">
                    ${otherCourtPlayers.map(p => `<option value="${p}">${p}</option>`).join('')}
                </optgroup>
            </select>
        </div>
        <div id="swapPreview" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.75rem;font-size:0.85rem;"></div>
        <div style="margin-top:1rem;text-align:right;">
            <button class="btn btn-primary" onclick="executeSwap()">✅ Confirm Swap</button>
        </div>
    `;

    document.getElementById('swapModalBody').innerHTML = html;

    // Set second dropdown to a different player by default
    const selectB = document.getElementById('swapPlayerB');
    if (thisCourtPlayers.length > 1) {
        selectB.value = thisCourtPlayers[1]; // pick the teammate by default
    }

    updateSwapPreview();
    document.getElementById('swapModal').classList.add('show');
}

function closeSwapModal() {
    document.getElementById('swapModal').classList.remove('show');
}

function updateSwapPreview() {
    const playerA = document.getElementById('swapPlayerA').value;
    const playerB = document.getElementById('swapPlayerB').value;
    const preview = document.getElementById('swapPreview');

    if (playerA === playerB) {
        preview.innerHTML = '<span style="color:var(--text-muted);">Pick two different players to swap.</span>';
        return;
    }

    const data = loadData();
    const week = data.weeks[swapState.weekIndex];
    const result = computeSwap(week, playerA, playerB);

    preview.innerHTML = `
        <div style="font-weight:600;margin-bottom:0.5rem;color:var(--accent);">After swap:</div>
        <div style="margin-bottom:0.4rem;"><strong>Court 1:</strong> ${result.court1.teamA.join(' & ')} vs ${result.court1.teamB.join(' & ')}</div>
        <div><strong>Court 2:</strong> ${result.court2.teamA.join(' & ')} vs ${result.court2.teamB.join(' & ')}</div>
    `;
}

function computeSwap(week, playerA, playerB) {
    // Clone all 4 teams
    const c1tA = [...week.firstHalf.court1.teamA];
    const c1tB = [...week.firstHalf.court1.teamB];
    const c2tA = [...week.firstHalf.court2.teamA];
    const c2tB = [...week.firstHalf.court2.teamB];

    const teams = [c1tA, c1tB, c2tA, c2tB];

    // Find which teams playerA and playerB are in
    let teamIdxA = -1, posA = -1, teamIdxB = -1, posB = -1;
    for (let t = 0; t < teams.length; t++) {
        const iA = teams[t].indexOf(playerA);
        if (iA !== -1) { teamIdxA = t; posA = iA; }
        const iB = teams[t].indexOf(playerB);
        if (iB !== -1) { teamIdxB = t; posB = iB; }
    }

    // Swap
    teams[teamIdxA][posA] = playerB;
    teams[teamIdxB][posB] = playerA;

    return {
        court1: { teamA: teams[0], teamB: teams[1] },
        court2: { teamA: teams[2], teamB: teams[3] }
    };
}

function executeSwap() {
    const playerA = document.getElementById('swapPlayerA').value;
    const playerB = document.getElementById('swapPlayerB').value;

    if (playerA === playerB) {
        showToast('Pick two different players!');
        return;
    }

    const data = loadData();
    const week = data.weeks[swapState.weekIndex];

    // Remove old pairings
    removePairingsForWeek(data, week);

    const result = computeSwap(week, playerA, playerB);

    // Update first half with swapped teams, reset scores
    week.firstHalf.court1.teamA = result.court1.teamA;
    week.firstHalf.court1.teamB = result.court1.teamB;
    week.firstHalf.court1.scoreA = null;
    week.firstHalf.court1.scoreB = null;
    week.firstHalf.court2.teamA = result.court2.teamA;
    week.firstHalf.court2.teamB = result.court2.teamB;
    week.firstHalf.court2.scoreA = null;
    week.firstHalf.court2.scoreB = null;
    week.secondHalf = null;

    // Add new pairings
    addPairingsForWeek(data, week);

    saveData(data);
    closeSwapModal();
    loadWeek();
    showToast(`Swapped ${playerA} ↔ ${playerB} 🔀`);
}

function hasFirstHalfScores(week) {
    const c1 = week.firstHalf.court1;
    const c2 = week.firstHalf.court2;
    return c1.scoreA !== null && c1.scoreB !== null && c2.scoreA !== null && c2.scoreB !== null;
}

function hasSecondHalfScores(week) {
    if (!week.secondHalf) return false;
    const w = week.secondHalf.winners;
    const l = week.secondHalf.losers;
    return w.scoreA !== null && w.scoreB !== null && l.scoreA !== null && l.scoreB !== null;
}

// ==================== SECOND HALF SETUP ====================
let pendingSecondHalf = null;

function setupSecondHalf(weekIndex) {
    const data = loadData();
    const week = data.weeks[weekIndex];
    const c1 = week.firstHalf.court1;
    const c2 = week.firstHalf.court2;

    let winner1, loser1, winner2, loser2;

    if (c1.scoreA > c1.scoreB) {
        winner1 = c1.teamA; loser1 = c1.teamB;
    } else if (c1.scoreB > c1.scoreA) {
        winner1 = c1.teamB; loser1 = c1.teamA;
    } else {
        pendingSecondHalf = { weekIndex, tiedCourt: 1, teamA: c1.teamA, teamB: c1.teamB };
        showCoinToss(c1.teamA, c1.teamB, 'Court 1');
        return;
    }

    if (c2.scoreA > c2.scoreB) {
        winner2 = c2.teamA; loser2 = c2.teamB;
    } else if (c2.scoreB > c2.scoreA) {
        winner2 = c2.teamB; loser2 = c2.teamA;
    } else {
        pendingSecondHalf = { weekIndex, tiedCourt: 2, winner1, loser1, teamA: c2.teamA, teamB: c2.teamB };
        showCoinToss(c2.teamA, c2.teamB, 'Court 2');
        return;
    }

    createSecondHalf(weekIndex, winner1, loser1, winner2, loser2);
}

function showCoinToss(teamA, teamB, courtLabel) {
    document.getElementById('coinModalText').textContent =
        `${courtLabel}: ${teamA.join(' & ')} vs ${teamB.join(' & ')} ended in a tie! Who wins the coin toss?`;
    document.getElementById('coinTeamA').textContent = teamA.join(' & ');
    document.getElementById('coinTeamB').textContent = teamB.join(' & ');
    document.getElementById('coinModal').classList.add('show');
}

function resolveCoinToss(choice) {
    document.getElementById('coinModal').classList.remove('show');
    const p = pendingSecondHalf;
    const data = loadData();
    const week = data.weeks[p.weekIndex];

    if (p.tiedCourt === 1) {
        const winner1 = choice === 'A' ? p.teamA : p.teamB;
        const loser1 = choice === 'A' ? p.teamB : p.teamA;

        const c2 = week.firstHalf.court2;
        if (c2.scoreA > c2.scoreB) {
            createSecondHalf(p.weekIndex, winner1, loser1, c2.teamA, c2.teamB);
        } else if (c2.scoreB > c2.scoreA) {
            createSecondHalf(p.weekIndex, winner1, loser1, c2.teamB, c2.teamA);
        } else {
            pendingSecondHalf = { weekIndex: p.weekIndex, tiedCourt: 2, winner1, loser1, teamA: c2.teamA, teamB: c2.teamB };
            showCoinToss(c2.teamA, c2.teamB, 'Court 2');
        }
    } else {
        const winner2 = choice === 'A' ? p.teamA : p.teamB;
        const loser2 = choice === 'A' ? p.teamB : p.teamA;
        createSecondHalf(p.weekIndex, p.winner1, p.loser1, winner2, loser2);
    }
}

function createSecondHalf(weekIndex, winner1, loser1, winner2, loser2) {
    const data = loadData();
    data.weeks[weekIndex].secondHalf = {
        winners: { teamA: winner1, teamB: winner2, scoreA: null, scoreB: null },
        losers: { teamA: loser1, teamB: loser2, scoreA: null, scoreB: null }
    };
    saveData(data);
    loadWeek();
    showToast('Second half set up! ⚡');
}

// ==================== COMPLETE WEEK ====================
function completeWeek(weekIndex) {
    const data = loadData();
    data.weeks[weekIndex].completed = true;
    saveData(data);
    loadWeek();
    updateLeaderboard();
    showToast('Week completed! 🎉');
}

function reopenWeek(weekIndex) {
    if (!confirm('Reopen this week? You can edit scores and set up the second half again.')) return;
    const data = loadData();
    data.weeks[weekIndex].completed = false;
    saveData(data);
    loadWeek();
    updateLeaderboard();
    showToast('Week reopened 🔓');
}

// ==================== LEADERBOARD ====================
function updateLeaderboard() {
    const data = loadData();
    const allPlayers = getAllPlayers(data);
    const scores = {};

    for (const p of allPlayers) {
        scores[p] = { games: 0, weeksPlayed: 0 };
    }

    for (const week of data.weeks) {
        if (!week.completed) continue;

        const weekPlayers = new Set();
        const halves = [week.firstHalf];
        if (week.secondHalf) halves.push(week.secondHalf);

        for (const half of halves) {
            for (const courtKey of Object.keys(half)) {
                const court = half[courtKey];
                if (court.scoreA !== null) {
                    for (const p of court.teamA) {
                        if (!scores[p]) scores[p] = { games: 0, weeksPlayed: 0 };
                        scores[p].games += court.scoreA;
                        weekPlayers.add(p);
                    }
                }
                if (court.scoreB !== null) {
                    for (const p of court.teamB) {
                        if (!scores[p]) scores[p] = { games: 0, weeksPlayed: 0 };
                        scores[p].games += court.scoreB;
                        weekPlayers.add(p);
                    }
                }
            }
        }

        for (const p of weekPlayers) {
            scores[p].weeksPlayed++;
        }
    }

    const completedWeeks = data.weeks.filter(w => w.completed).length;

    // Classify each player
    const allEntries = Object.entries(scores)
        .map(([name, s]) => {
            const inA = data.groupA.includes(name);
            const inB = data.groupB.includes(name);
            const inSubs = data.subs.includes(name);
            const groupTag = inA && inB ? 'A+B' : inA ? 'A' : inB ? 'B' : inSubs ? 'Sub' : 'Fill-in';
            const isSubOrFillIn = groupTag === 'Sub' || groupTag === 'Fill-in';
            return { name, ...s, avg: s.weeksPlayed > 0 ? s.games / s.weeksPlayed : 0, groupTag, isSubOrFillIn };
        })
        .filter(p => p.weeksPlayed > 0);

    const regulars = allEntries.filter(p => !p.isSubOrFillIn).sort((a, b) => b.avg - a.avg || b.games - a.games);
    const subs = allEntries.filter(p => p.isSubOrFillIn).sort((a, b) => b.avg - a.avg || b.games - a.games);

    if ((regulars.length === 0 && subs.length === 0) || completedWeeks === 0) {
        document.getElementById('leaderboardContent').innerHTML = `
            <div class="empty-state"><div class="emoji">📊</div><p>No scores recorded yet.</p></div>`;
        return;
    }

    const maxAvg = regulars.length > 0 ? regulars[0].avg : 1;

    let html = `<table class="leaderboard-table">
        <thead><tr>
            <th>#</th><th>Player</th><th>Avg/Week</th><th>Total</th><th>Weeks</th>
        </tr></thead><tbody>`;

    regulars.forEach((p, i) => {
        const rankClass = i < 3 ? `rank-${i + 1}` : '';
        const medal = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
        const pct = maxAvg > 0 ? (p.avg / maxAvg * 100) : 0;
        html += `<tr>
            <td><span class="rank ${rankClass}">${medal || (i + 1)}</span></td>
            <td><strong>${p.name}</strong> <span style="font-size:0.7rem;color:var(--text-muted)">${p.groupTag}</span></td>
            <td>
                ${p.avg.toFixed(1)}
                <div class="games-bar"><div class="games-bar-fill" style="width:${pct}%"></div></div>
            </td>
            <td style="font-size:0.85rem;color:var(--text-muted)">${p.games}</td>
            <td style="font-size:0.85rem;color:var(--text-muted)">${p.weeksPlayed}</td>
        </tr>`;
    });

    html += '</tbody></table>';

    // Subs/fill-ins in a separate section below
    if (subs.length > 0) {
        html += `<div style="margin-top:1.5rem;">
            <h3 style="font-size:0.9rem;color:var(--text-muted);margin-bottom:0.5rem;">🟠 Substitute Appearances</h3>
            <table class="leaderboard-table" style="opacity:0.6;">
            <thead><tr>
                <th>#</th><th>Player</th><th>Avg/Week</th><th>Total</th><th>Weeks</th>
            </tr></thead><tbody>`;
        subs.forEach((p, i) => {
            const pct = maxAvg > 0 ? (p.avg / maxAvg * 100) : 0;
            html += `<tr>
                <td><span class="rank">${i + 1}</span></td>
                <td><strong>${p.name}</strong> <span style="font-size:0.7rem;color:var(--text-muted)">${p.groupTag}</span></td>
                <td>
                    ${p.avg.toFixed(1)}
                    <div class="games-bar"><div class="games-bar-fill" style="width:${pct}%"></div></div>
                </td>
                <td style="font-size:0.85rem;color:var(--text-muted)">${p.games}</td>
                <td style="font-size:0.85rem;color:var(--text-muted)">${p.weeksPlayed}</td>
            </tr>`;
        });
        html += '</tbody></table></div>';
    }

    document.getElementById('leaderboardContent').innerHTML = html;
}

// ==================== HISTORY ====================
function updateHistory() {
    const data = loadData();
    const allWeeks = [...data.weeks].reverse();

    if (allWeeks.length === 0) {
        document.getElementById('historyContent').innerHTML = `
            <div class="empty-state"><div class="emoji">📚</div><p>No matches yet.</p></div>`;
        return;
    }

    let html = '';
    for (const week of allWeeks) {
        const weekIndex = data.weeks.indexOf(week);
        const groupLabel = week.group === 'A' ? '🔵 A' : '🟣 B';
        const statusIcon = week.completed ? '✅' : '⏳';
        const subsInfo = week.subs && week.subs.length > 0 ? ` • Subs: ${week.subs.join(', ')}` : '';
        html += `<div class="week-history">
            <div class="week-history-header" onclick="this.nextElementSibling.classList.toggle('open')">
                <span>${statusIcon} Week ${week.number} — ${week.date} ${groupLabel}${subsInfo}</span>
                <span style="display:flex;align-items:center;gap:0.5rem;">
                    <button class="btn btn-secondary" style="padding:0.25rem 0.6rem;font-size:0.75rem;" onclick="event.stopPropagation(); editWeekMatch(${weekIndex})">✏️ Edit</button>
                    <button class="btn btn-danger" style="padding:0.25rem 0.6rem;font-size:0.75rem;" onclick="event.stopPropagation(); deleteWeek(${weekIndex})">🗑</button>
                    <span>▼</span>
                </span>
            </div>
            <div class="week-history-body">`;

        html += '<h3 style="margin-bottom:0.5rem">First Half</h3>';
        html += renderHistoryMatch(week.firstHalf.court1, 'Court 1');
        html += renderHistoryMatch(week.firstHalf.court2, 'Court 2');

        if (week.secondHalf) {
            html += '<h3 style="margin:0.75rem 0 0.5rem">Second Half</h3>';
            html += renderHistoryMatch(week.secondHalf.winners, '🏆 Winners');
            html += renderHistoryMatch(week.secondHalf.losers, 'Consolation');
        }

        html += '</div></div>';
    }

    document.getElementById('historyContent').innerHTML = html;
}

function deleteWeek(weekIndex) {
    const data = loadData();
    const week = data.weeks[weekIndex];
    if (!confirm(`Delete Week ${week.number} (${week.date})? This will remove all scores and pairings for this week.`)) return;

    // Remove the pairings from history
    removePairingsForWeek(data, week);

    data.weeks.splice(weekIndex, 1);

    // Renumber remaining weeks
    data.weeks.forEach((w, i) => w.number = i + 1);

    saveData(data);
    updateHistory();
    updateLeaderboard();
    populateWeekSelect();
    loadWeek();
    updateSeasonBar();
    showToast('Week deleted 🗑');
}

function removePairingsForWeek(data, week) {
    if (!week.firstHalf) return;
    const weekPairs = [];
    for (const courtKey of Object.keys(week.firstHalf)) {
        const court = week.firstHalf[courtKey];
        if (court.teamA) weekPairs.push([...court.teamA]);
        if (court.teamB) weekPairs.push([...court.teamB]);
    }
    // For each pair generated this week, remove one occurrence from pairingHistory
    for (const pair of weekPairs) {
        if (pair.length !== 2) continue;
        const [a, b] = pair;
        const idx = data.pairingHistory.findIndex(([x, y]) =>
            (x === a && y === b) || (x === b && y === a)
        );
        if (idx !== -1) data.pairingHistory.splice(idx, 1);
    }
}

function renderHistoryMatch(court, label) {
    const winner = court.scoreA > court.scoreB ? 'A' : court.scoreB > court.scoreA ? 'B' : 'tie';
    const nameA = court.teamA.join(' & ');
    const nameB = court.teamB.join(' & ');
    return `<div class="history-match">
        <span style="color:var(--text-muted);width:100px;font-size:0.8rem">${label}</span>
        <span style="font-weight:${winner === 'A' ? '700' : '400'}">${nameA}</span>
        <span style="font-weight:700;color:var(--accent);margin:0 0.5rem">${court.scoreA} – ${court.scoreB}</span>
        <span style="font-weight:${winner === 'B' ? '700' : '400'}">${nameB}</span>
    </div>`;
}

// ==================== ADD / EDIT MATCH MODAL ====================
let matchModalMode = 'add'; // 'add' or 'edit'
let matchModalWeekIndex = null;

function getPlayerOptions(data) {
    return [...new Set([...data.groupA, ...data.groupB, ...data.subs, ...getAllPlayers(data)])];
}

function playerSelectHtml(id, allPlayers, selected) {
    let html = `<select id="${id}" style="flex:1;min-width:100px;">`;
    html += `<option value="">— pick —</option>`;
    for (const p of allPlayers) {
        html += `<option value="${p}" ${p === selected ? 'selected' : ''}>${p}</option>`;
    }
    html += `</select>`;
    return html;
}

function buildMatchFormHtml(data, week) {
    const allPlayers = getPlayerOptions(data);
    const hasSecond = week && week.secondHalf;

    // Default date: next available Tuesday
    const defaultDate = week ? week.date : new Date().toISOString().split('T')[0];
    const defaultGroup = week ? week.group : 'A';

    // First half courts
    const fh = week ? week.firstHalf : {
        court1: { teamA: ['',''], teamB: ['',''], scoreA: null, scoreB: null },
        court2: { teamA: ['',''], teamB: ['',''], scoreA: null, scoreB: null }
    };

    // Second half courts
    const sh = hasSecond ? week.secondHalf : {
        winners: { teamA: ['',''], teamB: ['',''], scoreA: null, scoreB: null },
        losers: { teamA: ['',''], teamB: ['',''], scoreA: null, scoreB: null }
    };

    let html = `
        <div style="display:flex;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap;">
            <div style="flex:1;min-width:140px;">
                <label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:0.25rem;">Date</label>
                <input type="date" id="mm_date" value="${defaultDate}" style="width:100%;">
            </div>
            <div style="flex:1;min-width:100px;">
                <label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:0.25rem;">Group</label>
                <select id="mm_group" style="width:100%;">
                    <option value="A" ${defaultGroup === 'A' ? 'selected' : ''}>🔵 Group A</option>
                    <option value="B" ${defaultGroup === 'B' ? 'selected' : ''}>🟣 Group B</option>
                </select>
            </div>
        </div>

        <h3 style="margin-bottom:0.5rem;color:var(--text);">First Half</h3>
        ${buildCourtFormHtml('Court 1', 'mm_fh_c1', allPlayers, fh.court1)}
        ${buildCourtFormHtml('Court 2', 'mm_fh_c2', allPlayers, fh.court2)}

        <div style="margin-top:0.75rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.9rem;">
                <input type="checkbox" id="mm_hasSecondHalf" ${hasSecond ? 'checked' : ''} onchange="toggleSecondHalfForm()">
                Include Second Half
            </label>
        </div>

        <div id="mm_secondHalfForm" style="display:${hasSecond ? 'block' : 'none'};margin-top:0.75rem;">
            <h3 style="margin-bottom:0.5rem;color:var(--accent);">Second Half</h3>
            ${buildCourtFormHtml('🏆 Winners', 'mm_sh_win', allPlayers, sh.winners)}
            ${buildCourtFormHtml('Consolation', 'mm_sh_lose', allPlayers, sh.losers)}
        </div>
    `;

    return html;
}

function buildCourtFormHtml(label, prefix, allPlayers, court) {
    const tA = court.teamA || ['', ''];
    const tB = court.teamB || ['', ''];
    const sA = court.scoreA !== null && court.scoreA !== undefined ? court.scoreA : '';
    const sB = court.scoreB !== null && court.scoreB !== undefined ? court.scoreB : '';

    return `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:0.5rem;">${label}</div>
            <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                <div style="flex:1;min-width:120px;">
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:0.2rem;">Team A</div>
                    <div style="display:flex;gap:0.3rem;">
                        ${playerSelectHtml(prefix + '_tA1', allPlayers, tA[0])}
                        ${playerSelectHtml(prefix + '_tA2', allPlayers, tA[1])}
                    </div>
                </div>
                <div style="display:flex;gap:0.3rem;align-items:flex-end;">
                    <div>
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:0.2rem;text-align:center;">Score</div>
                        <input type="number" id="${prefix}_sA" value="${sA}" min="0" style="width:50px;text-align:center;font-weight:700;">
                    </div>
                    <span style="color:var(--accent);font-weight:800;padding-bottom:0.4rem;">–</span>
                    <div>
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:0.2rem;text-align:center;">Score</div>
                        <input type="number" id="${prefix}_sB" value="${sB}" min="0" style="width:50px;text-align:center;font-weight:700;">
                    </div>
                </div>
                <div style="flex:1;min-width:120px;">
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:0.2rem;">Team B</div>
                    <div style="display:flex;gap:0.3rem;">
                        ${playerSelectHtml(prefix + '_tB1', allPlayers, tB[0])}
                        ${playerSelectHtml(prefix + '_tB2', allPlayers, tB[1])}
                    </div>
                </div>
            </div>
        </div>`;
}

function toggleSecondHalfForm() {
    const show = document.getElementById('mm_hasSecondHalf').checked;
    document.getElementById('mm_secondHalfForm').style.display = show ? 'block' : 'none';
}

function showAddMatchModal() {
    matchModalMode = 'add';
    matchModalWeekIndex = null;
    const data = loadData();

    document.getElementById('matchModalTitle').textContent = '➕ Add Past Match';
    document.getElementById('matchModalSave').textContent = 'Add Match';
    document.getElementById('matchModalBody').innerHTML = buildMatchFormHtml(data, null);
    document.getElementById('matchModal').classList.add('show');
}

function editWeekMatch(weekIndex) {
    matchModalMode = 'edit';
    matchModalWeekIndex = weekIndex;
    const data = loadData();
    const week = data.weeks[weekIndex];

    document.getElementById('matchModalTitle').textContent = `✏️ Edit Week ${week.number}`;
    document.getElementById('matchModalSave').textContent = 'Save Changes';
    document.getElementById('matchModalBody').innerHTML = buildMatchFormHtml(data, week);
    document.getElementById('matchModal').classList.add('show');
}

function closeMatchModal() {
    document.getElementById('matchModal').classList.remove('show');
}

function readCourtFromForm(prefix) {
    const tA1 = document.getElementById(prefix + '_tA1').value;
    const tA2 = document.getElementById(prefix + '_tA2').value;
    const tB1 = document.getElementById(prefix + '_tB1').value;
    const tB2 = document.getElementById(prefix + '_tB2').value;
    const sA = document.getElementById(prefix + '_sA').value;
    const sB = document.getElementById(prefix + '_sB').value;

    return {
        teamA: [tA1, tA2],
        teamB: [tB1, tB2],
        scoreA: sA !== '' ? parseInt(sA) : null,
        scoreB: sB !== '' ? parseInt(sB) : null
    };
}

function saveMatchModal() {
    const data = loadData();

    const date = document.getElementById('mm_date').value;
    const group = document.getElementById('mm_group').value;
    const hasSecondHalf = document.getElementById('mm_hasSecondHalf').checked;

    const fhCourt1 = readCourtFromForm('mm_fh_c1');
    const fhCourt2 = readCourtFromForm('mm_fh_c2');

    // Validate: all 8 first-half player slots must be filled
    const firstHalfPlayers = [...fhCourt1.teamA, ...fhCourt1.teamB, ...fhCourt2.teamA, ...fhCourt2.teamB];
    if (firstHalfPlayers.some(p => !p)) {
        showToast('Please select all 8 players for the first half');
        return;
    }

    // Check for duplicates
    const uniqueCheck = new Set(firstHalfPlayers);
    if (uniqueCheck.size !== 8) {
        showToast('Each player can only appear once!');
        return;
    }

    // Validate scores
    if (fhCourt1.scoreA === null || fhCourt1.scoreB === null || fhCourt2.scoreA === null || fhCourt2.scoreB === null) {
        showToast('Please enter all first half scores');
        return;
    }

    let secondHalf = null;
    if (hasSecondHalf) {
        const shWin = readCourtFromForm('mm_sh_win');
        const shLose = readCourtFromForm('mm_sh_lose');
        const shPlayers = [...shWin.teamA, ...shWin.teamB, ...shLose.teamA, ...shLose.teamB];
        if (shPlayers.some(p => !p)) {
            showToast('Please select all players for the second half');
            return;
        }
        if (shWin.scoreA === null || shWin.scoreB === null || shLose.scoreA === null || shLose.scoreB === null) {
            showToast('Please enter all second half scores');
            return;
        }
        secondHalf = { winners: shWin, losers: shLose };
    }

    const defaultPlayers = group === 'A' ? data.groupA : data.groupB;
    const subNames = firstHalfPlayers.filter(p => !defaultPlayers.includes(p));

    if (matchModalMode === 'edit') {
        const week = data.weeks[matchModalWeekIndex];

        // Remove old pairings from history
        removePairingsForWeek(data, week);

        week.date = date;
        week.group = group;
        week.roster = [...firstHalfPlayers];
        week.subs = subNames;
        week.firstHalf = { court1: fhCourt1, court2: fhCourt2 };
        week.secondHalf = secondHalf;
        week.completed = true;

        // Add new pairings
        addPairingsForWeek(data, week);

        saveData(data);
        closeMatchModal();
        updateHistory();
        updateLeaderboard();
        populateWeekSelect();
        loadWeek();
        showToast(`Week ${week.number} updated! ✏️`);
    } else {
        // Add mode — insert as a new completed week
        const weekNum = data.weeks.length + 1;

        const week = {
            number: weekNum,
            date: date,
            group: group,
            roster: [...firstHalfPlayers],
            subs: subNames,
            playlistUri: null,
            firstHalf: { court1: fhCourt1, court2: fhCourt2 },
            secondHalf: secondHalf,
            completed: true
        };

        data.weeks.push(week);

        // Add pairings to history
        addPairingsForWeek(data, week);

        // Sort weeks by date
        data.weeks.sort((a, b) => a.date.localeCompare(b.date));
        data.weeks.forEach((w, i) => w.number = i + 1);

        saveData(data);
        closeMatchModal();
        updateHistory();
        updateLeaderboard();
        populateWeekSelect();
        loadWeek();
        updateSeasonBar();
        showToast(`Week ${week.number} added! ➕`);
    }
}

function addPairingsForWeek(data, week) {
    if (!week.firstHalf) return;
    for (const courtKey of Object.keys(week.firstHalf)) {
        const court = week.firstHalf[courtKey];
        if (court.teamA && court.teamA.length === 2) data.pairingHistory.push([...court.teamA]);
        if (court.teamB && court.teamB.length === 2) data.pairingHistory.push([...court.teamB]);
    }
}

// ==================== UI HELPERS ====================
function showSection(id) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    if (id === 'leaderboard') updateLeaderboard();
    if (id === 'history') updateHistory();
    if (id === 'nextweek') renderNextWeek();
    if (id === 'gallery') renderGallery();
    if (id === 'players') renderRosters();
}

function populateWeekSelect() {
    const data = loadData();
    const select = document.getElementById('weekSelect');
    select.innerHTML = '';
    if (data.weeks.length === 0) {
        select.innerHTML = '<option value="">No weeks yet</option>';
        return;
    }
    data.weeks.forEach((w, i) => {
        const status = w.completed ? '✅' : '⏳';
        const groupTag = w.group === 'A' ? '🔵' : '🟣';
        select.innerHTML += `<option value="${i}">${status} ${groupTag} Week ${w.number} — ${w.date}</option>`;
    });
    select.value = data.weeks.length - 1;
}

function updateSeasonBar() {
    const data = loadData();
    const completed = data.weeks.filter(w => w.completed).length;
    const total = data.weeks.length;
    const displayWeek = total > 0 ? total : 0;
    document.getElementById('seasonWeekLabel').textContent = `Week ${displayWeek} / ${TOTAL_WEEKS}`;
    document.getElementById('seasonProgressFill').style.width = (completed / TOTAL_WEEKS * 100) + '%';
    document.getElementById('seasonWeeksLeft').textContent = `${TOTAL_WEEKS - total} weeks left`;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

function resetSeason() {
    if (!confirm('⚠️ This will delete ALL data including players, scores, and history. Are you sure?')) return;
    localStorage.removeItem(STORAGE_KEY);
    init();
    showToast('Season reset! 🔄');
}

function exportData() {
    const data = loadData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'padel-tuesdays-backup.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported! 📤');
}

function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                saveData(data);
                init();
                showToast('Data imported! 📥');
            } catch {
                showToast('Invalid file!');
            }
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

// ==================== PLAYLIST MANAGEMENT ====================
function parsePlaylistUri(input) {
    const urlMatch = input.match(/playlist\/([a-zA-Z0-9]+)/);
    if (urlMatch) return 'spotify:playlist:' + urlMatch[1];
    if (input.startsWith('spotify:playlist:')) return input;
    return null;
}

function addPlaylist() {
    const input = document.getElementById('newPlaylistUri');
    const uri = parsePlaylistUri(input.value.trim());
    if (!uri) {
        showToast('Invalid playlist link!');
        return;
    }
    const data = loadData();
    if (!data.playlists) data.playlists = [];
    if (data.playlists.includes(uri)) {
        showToast('Playlist already added!');
        return;
    }
    data.playlists.push(uri);
    saveData(data);
    input.value = '';
    renderPlaylists();
    showToast('Playlist added! 🎵');
}

function removePlaylist(index) {
    const data = loadData();
    data.playlists.splice(index, 1);
    saveData(data);
    renderPlaylists();
    showToast('Playlist removed');
}

function renderPlaylists() {
    const data = loadData();
    const grid = document.getElementById('playlistGrid');
    if (!data.playlists || data.playlists.length === 0) {
        grid.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No playlists added yet.</p>';
        return;
    }
    grid.innerHTML = data.playlists.map((uri, i) => {
        const playlistId = uri.split(':').pop();
        return `
            <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border);">
                <span style="color: var(--accent); font-weight: 700; font-size: 0.8rem; min-width: 24px;">#${i + 1}</span>
                <iframe
                    src="https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0"
                    height="80"
                    style="border-radius: 8px; flex: 1; border: none;"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    loading="lazy">
                </iframe>
                <span class="remove" onclick="removePlaylist(${i})" style="cursor:pointer; color: var(--text-muted); font-size: 1.1rem;">✕</span>
            </div>`;
    }).join('');
}

// ==================== BACKGROUND SLIDESHOW ====================
let bgSlideInterval = null;
let bgCurrentIndex = 0;
let bgActiveSlot = 'A'; // toggle between A and B for crossfade

function startBackgroundSlideshow() {
    const photos = loadGallery();
    if (photos.length === 0) {
        // No photos — clear any existing backgrounds
        document.getElementById('headerBgSlideA').style.backgroundImage = '';
        document.getElementById('headerBgSlideB').style.backgroundImage = '';
        document.getElementById('bodyBgContainer').innerHTML = '';
        if (bgSlideInterval) { clearInterval(bgSlideInterval); bgSlideInterval = null; }
        return;
    }

    // Set up body background slides (two for crossfade)
    const container = document.getElementById('bodyBgContainer');
    if (!document.getElementById('bodyBgSlideA')) {
        container.innerHTML = `
            <div class="body-bg-slide" id="bodyBgSlideA"></div>
            <div class="body-bg-slide" id="bodyBgSlideB"></div>
        `;
    }

    // Show first image immediately
    bgCurrentIndex = Math.floor(Math.random() * photos.length);
    showBgSlide(photos, bgCurrentIndex);

    // Rotate every 8 seconds
    if (bgSlideInterval) clearInterval(bgSlideInterval);
    bgSlideInterval = setInterval(() => {
        const currentPhotos = loadGallery();
        if (currentPhotos.length === 0) {
            startBackgroundSlideshow(); // will clear everything
            return;
        }
        bgCurrentIndex = (bgCurrentIndex + 1) % currentPhotos.length;
        showBgSlide(currentPhotos, bgCurrentIndex);
    }, 8000);
}

function showBgSlide(photos, index) {
    const photo = photos[index];
    const incoming = bgActiveSlot === 'A' ? 'B' : 'A';

    // Header crossfade
    const headerIncoming = document.getElementById('headerBgSlide' + incoming);
    const headerOutgoing = document.getElementById('headerBgSlide' + bgActiveSlot);
    headerIncoming.style.backgroundImage = `url(${photo.data})`;
    headerIncoming.classList.add('active');
    headerOutgoing.classList.remove('active');

    // Body crossfade
    const bodyIncoming = document.getElementById('bodyBgSlide' + incoming);
    const bodyOutgoing = document.getElementById('bodyBgSlide' + bgActiveSlot);
    if (bodyIncoming && bodyOutgoing) {
        bodyIncoming.style.backgroundImage = `url(${photo.data})`;
        bodyIncoming.classList.add('active');
        bodyOutgoing.classList.remove('active');
    }

    bgActiveSlot = incoming;
}

// ==================== GALLERY (Cloud-backed via Google Sheets) ====================
let _galleryCache = [];       // in-memory cache of photos (with base64 data)
let _galleryCacheReady = false;
let currentLightboxIndex = 0;

// --- Cloud API helpers ---

async function cloudGalleryList() {
    // Fetch metadata only (fast) — no base64 data
    try {
        const res = await fetch(SHEETS_API + '?action=getGallery');
        return await res.json();
    } catch (e) {
        console.warn('Cloud gallery list failed:', e);
        return [];
    }
}

async function cloudGalleryFull() {
    // Fetch everything including base64 data (heavy but needed for slideshow/lightbox)
    try {
        const res = await fetch(SHEETS_API + '?action=getGallery&withData=true');
        return await res.json();
    } catch (e) {
        console.warn('Cloud gallery full load failed:', e);
        return [];
    }
}

async function cloudGetPhoto(id) {
    try {
        const res = await fetch(SHEETS_API + '?action=getPhoto&id=' + encodeURIComponent(id));
        return await res.json();
    } catch (e) {
        console.warn('Cloud getPhoto failed:', e);
        return null;
    }
}

async function cloudAddPhoto(photo) {
    try {
        await fetch(SHEETS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'addPhoto', photo })
        });
    } catch (e) {
        console.warn('Cloud addPhoto failed:', e);
        throw e;
    }
}

async function cloudUpdateCaption(id, caption) {
    try {
        await fetch(SHEETS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'updateCaption', id, caption })
        });
    } catch (e) {
        console.warn('Cloud updateCaption failed:', e);
    }
}

async function cloudDeletePhoto(id) {
    try {
        await fetch(SHEETS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'deletePhoto', id })
        });
    } catch (e) {
        console.warn('Cloud deletePhoto failed:', e);
    }
}

// --- Gallery cache (replaces localStorage gallery) ---

function loadGallery() {
    // Synchronous read from in-memory cache (used by slideshow, lightbox, render)
    return _galleryCache;
}

async function refreshGalleryCache() {
    // Pull full gallery from cloud into memory
    try {
        _galleryCache = await cloudGalleryFull();
        _galleryCacheReady = true;
    } catch (e) {
        console.warn('Gallery cache refresh failed:', e);
        if (!_galleryCacheReady) _galleryCache = [];
    }
}

// Initial load of gallery from cloud
refreshGalleryCache().then(() => {
    renderGallery();
    startBackgroundSlideshow();
});

// --- Drag & drop ---
const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
});
uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length > 0) processFiles(files);
});

function handleFileSelect(event) {
    const files = [...event.target.files].filter(f => f.type.startsWith('image/'));
    if (files.length > 0) processFiles(files);
    event.target.value = ''; // reset so same file can be re-selected
}

function processFiles(files) {
    let processed = 0;
    const total = files.length;

    showToast(`Uploading ${total} photo${total > 1 ? 's' : ''}...`);

    for (const file of files) {
        const reader = new FileReader();
        reader.onload = (e) => {
            resizeImage(e.target.result, 1200, async (resizedDataUrl) => {
                const photo = {
                    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    data: resizedDataUrl,
                    caption: '',
                    date: new Date().toISOString().split('T')[0],
                    filename: file.name
                };

                // Optimistic: add to local cache immediately
                _galleryCache.push(photo);
                processed++;

                // Upload to cloud
                try {
                    await cloudAddPhoto(photo);
                } catch (err) {
                    console.warn('Upload to cloud failed for', file.name, err);
                }

                if (processed === total) {
                    renderGallery();
                    startBackgroundSlideshow();
                    showToast(`${total} photo${total > 1 ? 's' : ''} uploaded! 📸`);
                }
            });
        };
        reader.readAsDataURL(file);
    }
}

function resizeImage(dataUrl, maxDim, callback) {
    const img = new Image();
    img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrl;
}

function renderGallery() {
    const photos = loadGallery();
    const grid = document.getElementById('galleryGrid');
    const filterBar = document.getElementById('galleryFilterBar');
    const countEl = document.getElementById('galleryCount');

    if (photos.length === 0) {
        filterBar.style.display = 'none';
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="emoji">📷</div>
                <p>No photos yet.</p>
                <p>Upload your padel memories!</p>
            </div>`;
        return;
    }

    filterBar.style.display = 'flex';
    countEl.textContent = `${photos.length} photo${photos.length !== 1 ? 's' : ''}`;

    grid.innerHTML = photos.map((photo, i) => `
        <div class="gallery-item" onclick="openLightbox(${i})">
            <img src="${photo.data}" alt="${photo.caption || photo.filename}" loading="lazy">
            <div class="gallery-item-info">
                <span class="gallery-item-caption" id="caption-${photo.id}"
                    onclick="event.stopPropagation(); editCaption('${photo.id}')"
                    title="Click to edit caption">
                    ${photo.caption || '✏️ Add caption...'}
                </span>
                <span class="gallery-item-date">${photo.date}</span>
            </div>
            <button class="remove-photo" onclick="event.stopPropagation(); removePhoto('${photo.id}')">✕</button>
        </div>
    `).join('');
}

async function editCaption(photoId) {
    const photo = _galleryCache.find(p => p.id === photoId);
    if (!photo) return;

    const newCaption = prompt('Caption:', photo.caption || '');
    if (newCaption === null) return; // cancelled

    // Update local cache immediately
    photo.caption = newCaption;
    renderGallery();

    // Persist to cloud
    await cloudUpdateCaption(photoId, newCaption);
    showToast('Caption updated ✏️');
}

async function removePhoto(photoId) {
    if (!confirm('Remove this photo?')) return;

    // Remove from local cache immediately
    _galleryCache = _galleryCache.filter(p => p.id !== photoId);
    renderGallery();
    startBackgroundSlideshow();

    // Persist to cloud
    await cloudDeletePhoto(photoId);
    showToast('Photo removed');
}

function openLightbox(index) {
    const photos = loadGallery();
    if (photos.length === 0) return;
    currentLightboxIndex = index;
    const photo = photos[index];
    document.getElementById('lightboxImg').src = photo.data;
    document.getElementById('lightboxCaption').textContent = photo.caption || photo.filename || '';
    document.getElementById('lightbox').classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    if (event.target.classList.contains('lightbox-nav') || event.target.classList.contains('lightbox-prev') || event.target.classList.contains('lightbox-next')) return;
    document.getElementById('lightbox').classList.remove('show');
    document.body.style.overflow = '';
}

function navigateLightbox(event, direction) {
    event.stopPropagation();
    const photos = loadGallery();
    if (photos.length === 0) return;
    currentLightboxIndex = (currentLightboxIndex + direction + photos.length) % photos.length;
    const photo = photos[currentLightboxIndex];
    document.getElementById('lightboxImg').src = photo.data;
    document.getElementById('lightboxCaption').textContent = photo.caption || photo.filename || '';
}

// Keyboard navigation for lightbox
document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lightbox').classList.contains('show')) return;
    if (e.key === 'Escape') { document.getElementById('lightbox').classList.remove('show'); document.body.style.overflow = ''; }
    if (e.key === 'ArrowLeft') navigateLightbox(e, -1);
    if (e.key === 'ArrowRight') navigateLightbox(e, 1);
});

// ==================== INIT ====================
const DEFAULT_PLAYLISTS = [
    'spotify:playlist:2akGcecFZy9bx3Clvei53L',
    'spotify:playlist:6hu8d3wjCRuJIYH1yZ2wCS',
    'spotify:playlist:2y7DeotmDFILmoELjQKiz3',
    'spotify:playlist:5EI3i3rAtBOZHh8uEFWlSh',
    'spotify:playlist:0lMLk1EX0NElqT4U3n6bzC',
    'spotify:playlist:6mWWxcedvw8wdEnlYUk36P',
    'spotify:playlist:5tDfhOzqHXMsksI15lIL88',
    'spotify:playlist:3MzgLDEjzSAok9of42uvPM',
    'spotify:playlist:0zqrq6pMAXwdIYkxujmU0S',
    'spotify:playlist:6AySIqy8RMKjtSeNfBxs2Q',
];

const DEFAULT_GROUP_A = ['Louise', 'Ullis', 'Ida', 'Cecilia', 'Gabbi', 'Sara B', 'Amelie', 'Anna'];
const DEFAULT_GROUP_B = ['Monica', 'Sara C', 'Ida', 'Cecilia', 'Gabbi', 'Sara B', 'Amelie', 'Anna'];

function renderAll() {
    renderRosters();
    renderPlaylists();
    populateWeekSelect();
    loadWeek();
    updateSeasonBar();
    updateLeaderboard();
}

function init(skipCloudSave) {
    const data = loadData();

    let changed = false;

    // Pre-seed rosters if empty
    if (data.groupA.length === 0 && data.groupB.length === 0) {
        data.groupA = [...DEFAULT_GROUP_A];
        data.groupB = [...DEFAULT_GROUP_B];
        data.subs = [];
        changed = true;
    }

    // Pre-seed playlists if empty
    if (!data.playlists || data.playlists.length === 0) {
        data.playlists = [...DEFAULT_PLAYLISTS];
        changed = true;
    }

    if (changed) {
        saveData(data);
    } else {
        // Just update local cache, don't trigger cloud save
        _cachedData = data;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    renderAll();
    // Gallery & slideshow are loaded async from cloud via refreshGalleryCache()
}

// Don't call init() immediately — wait for cloud data.
// The loadFromCloud().then(...) at the top handles the initial render.
