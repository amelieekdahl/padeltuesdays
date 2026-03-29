# Padel Tuesdays — System Prompt

**Build a single-page web application called "Padel Tuesdays" — a padel tournament tracker and social hub for a recurring weekly padel group. The app is a self-contained `index.html` file (HTML + CSS + JS, no framework) with a Google Apps Script backend (`Code.gs`) for shared cloud persistence.**

## Core Concept

A 20-week season of weekly Tuesday padel matches. Players are split into two groups (**Group A** and **Group B**) that alternate weeks (odd weeks = Group A, even weeks = Group B). Each week, 8 players play on 2 courts. The season starts March 31, 2026.

## Architecture

- **Frontend**: Single `index.html` file with inline CSS and JS. No build tools, no framework — pure vanilla.
- **Data persistence**: Dual-layer — **localStorage** for instant reads and **Google Sheets** (via Apps Script web app) for shared/cloud persistence. On page load, data is fetched from the cloud and cached locally. All writes go to both localStorage and cloud (async, fire-and-forget with `no-cors`). Every mutation (score entry, match creation, roster change, etc.) calls `saveData()` which persists to both layers.
- **Backend**: Google Apps Script (`Code.gs`) deployed as a web app. It stores tournament data as a JSON blob in a "Data" sheet (cell A1) and photo gallery data in a "Gallery" sheet (one row per photo with columns: id, caption, date, filename, base64 data). Supports `doGet` and `doPost` with action-based routing.

## Design

- **Dark theme** with CSS custom properties. Background: near-black (`#0a0a0f`), surfaces: dark purples/blues, accent: gold (`#f5c542`).
- **Font**: Inter (Google Fonts).
- **Color coding**: Group A = blue (`#60a5fa`), Group B = purple (`#a78bfa`), Subs/Fill-ins = orange (`#fb923c`), accent/gold for highlights, green for success, red for danger.
- **Responsive** with media queries for mobile (single-column courts grid under 640px).
- **Background slideshow**: Gallery photos are displayed as blurred background images across the entire page and header, with crossfade transitions every 8 seconds using a dual-slot (A/B) technique.

## Navigation (6 tabs)

1. **📋 Match Day** — View current week's matches, enter scores, set up second half, complete weeks. Shows season progress bar (X/20 weeks), week selector dropdown, court cards with score inputs, and Spotify playlist embed for the week. Completed weeks can be **reopened** via a 🔓 Reopen button to fix scores or re-do the second half.

2. **📅 Next Week** — Plan the upcoming week's roster. Auto-fills from the scheduled group. Each slot dropdown is organized into sections: the default group's players first, then players exclusive to the other group (e.g., on a Group A week, only Louise and Ullis appear in the Group A section, while Monica and Sara C appear under "Group B" — shared players like Ida, Cecilia, etc. only appear under the default group), then subs, and finally a **"✏️ Type a name..."** option for **fill-in players** not in any group — useful when someone is sick and a friend fills in. Players already selected are disabled in other slots. Fill-ins appear with a "FILL-IN" badge and orange highlight, and are tracked on the leaderboard but don't pollute the regular group rosters. Shows a playlist selector for the week. Requires exactly 8 players to generate. "Confirm & Generate Matches" button locks in the roster and creates match pairings.

3. **🏅 Leaderboard** — Season standings table showing rank (with medal emojis for top 3), player name + group tag (A, B, A+B, Sub, or Fill-in), total games won (with visual bar), weeks played, and per-week average. Sorted by total games won. Fill-in players who aren't in any roster group are tagged as "Fill-in".

4. **📜 History** — Accordion-style list of all weeks (newest first), showing both completed (✅) and in-progress (⏳) weeks. Each expands to show first-half and second-half results with team names and scores. Shows group indicator and sub names. Each week has **✏️ Edit** and **🗑 Delete** buttons. An **➕ Add Past Match** button at the top allows manually entering historical match results. Editing properly updates pairing history (removes old pairings, adds new ones). Deleting a week cleans up pairings and renumbers remaining weeks.

5. **📸 Gallery** — Cloud-backed photo gallery. Drag & drop or click to upload. Photos are resized to max 1200px and stored as base64 JPEG in Google Sheets. Features: editable captions (prompt-based), delete button on hover, photo count, fullscreen lightbox with keyboard navigation (← → Esc) and prev/next buttons. Gallery photos feed the background slideshow.

6. **👥 Players** — Roster management for Group A (max 8), Group B (max 8), and Substitute pool (unlimited). Add/remove players with duplicate checking. Also contains: **Spotify playlist management** (add/remove playlists by URL or URI, rendered as embedded Spotify iframes, auto-rotating through weeks) and **Season management** (reset season, export/import JSON backup).

## Match Format

- **First Half (45 min)**: 8 players → 4 pairs → 2 courts, each with Team A vs Team B.
- **Second Half**: After first-half scores are entered, winners play winners on a "🏆 Winners Court" and losers play on a "Consolation Court." If a first-half match is tied, a **coin toss modal** lets the user pick the winner.
- **Completion**: After second-half scores are entered, the week can be marked complete, which updates the leaderboard and history. Completed weeks can be reopened to make corrections.

## Fill-in Players

When a regular player is sick, a fill-in can be added directly in the Next Week planner:
- Select **"✏️ Type a name..."** from any roster slot dropdown to enter an ad-hoc name.
- Fill-ins are shown with an orange "FILL-IN" badge and editable text input (with ✕ to clear).
- Fill-ins are **not** added to Group A, Group B, or the Sub pool — they only exist in that week's roster data.
- Fill-ins appear on the **leaderboard** tagged as "Fill-in" with their scores tracked normally.
- The pairing algorithm handles fill-ins gracefully — they're treated as any other player for that week.

## Pairing Algorithm

Uses an **exhaustive optimal matching algorithm** with strict round-robin fairness — no player repeats a partner until they've played with every other player in the roster:

1. Build a pair count map tracking how many times each possible pair has been teammates (from `pairingHistory`).
2. For each player, calculate `playerMin` — the fewest times they've been paired with any other player in this week's roster. This represents their "cheapest available partner".
3. Enumerate all possible ways to pair 8 players into 4 pairs.
4. Score each combination with three tiers:
   - **Violations** (×1,000,000): A pair where both players have partners they've played with fewer times — meaning both have un-played partners available but are being paired anyway.
   - **Max count** (×1,000): The highest repeat count in any single pair.
   - **Total count**: Sum of all pair counts (tiebreaker).
5. Pick the combination with the lowest score.
6. Candidates are sorted by count (ascending) during enumeration for efficiency.
7. Courts are assigned randomly from the 4 generated pairs.

**Result**: With 8 fixed players, every player plays with every other player exactly once over 7 weeks (a full round-robin cycle), then the cycle repeats. Fill-ins and subs are handled naturally within the same algorithm.

## Match History Management

- **Add Past Match**: Opens a modal form with date picker, group selector, player dropdowns for all 4 teams (2 courts × 2 teams), score inputs, and optional second half. Validates all players filled, no duplicates, all scores entered. Adds pairings to history and sorts weeks by date.
- **Edit Match**: Same form pre-filled with existing data. Properly removes old pairings and adds updated ones.
- **Delete Match**: Confirmation dialog, removes pairings from history, renumbers remaining weeks.
- **Reopen Week**: Completed weeks can be unlocked from Match Day to fix scores or redo second half setup.

## Data Model

```js
{
  groupA: string[],           // Group A players (max 8)
  groupB: string[],           // Group B players (max 8)
  subs: string[],             // Substitute pool
  weeks: [{
    number: number,
    date: string,              // ISO date
    group: 'A' | 'B',
    roster: string[],          // The 8 players who played
    subs: string[],            // Which of the 8 were subs/fill-ins
    playlistUri: string | null,
    firstHalf: {
      court1: { teamA: [p1,p2], teamB: [p3,p4], scoreA: number|null, scoreB: number|null },
      court2: { teamA: [p5,p6], teamB: [p7,p8], scoreA: number|null, scoreB: number|null }
    },
    secondHalf: null | {
      winners: { teamA, teamB, scoreA, scoreB },
      losers:  { teamA, teamB, scoreA, scoreB }
    },
    completed: boolean
  }],
  pairingHistory: [string, string][],  // All historical teammate pairs
  nextWeekRoster: string[] | null,      // Proposed roster for next week
  nextWeekPlaylistIndex: number | null,
  playlists: string[]                    // Spotify playlist URIs
}
```

## Gallery Data (Google Sheets "Gallery" sheet)

Each photo is one row: `id | caption | date | filename | base64_data`. The Apps Script supports: `getGallery` (metadata only or with data), `getPhoto` (single photo by ID), `addPhoto`, `updateCaption`, `deletePhoto`.

## Spotify Integration

- A pool of Spotify playlist URIs that auto-rotate through weeks (week N uses playlist index `(N-1) % total`).
- Playlists are rendered as embedded Spotify iframes (using `open.spotify.com/embed/playlist/`).
- Each match day shows its assigned playlist. The Next Week planner allows overriding the default rotation.

## Pre-seeded Defaults

- **Group A**: Louise, Ullis, Ida, Cecilia, Gabbi, Sara B, Amelie, Anna
- **Group B**: Monica, Sara C, Ida, Cecilia, Gabbi, Sara B, Amelie, Anna
- **10 default Spotify playlists** pre-loaded

## UX Details

- Toast notifications for all actions (bottom-center, gold, auto-dismiss 2.5s).
- Coin toss modal for tied first-half matches.
- Confirm dialogs for destructive actions (remove player with history, reset season, delete week).
- Hover effects on gallery items (lift + shadow), player chips, nav buttons.
- Lightbox with click-outside-to-close and keyboard shortcuts.
- Season progress bar in match day view.
- Group indicators (colored badges) throughout.
- Modals have max-height with scroll for smaller screens.
- History entries show status icons (✅ completed, ⏳ in-progress) with inline edit/delete controls.
