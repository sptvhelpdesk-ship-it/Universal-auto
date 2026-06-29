const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");

// --- 1. CONFIGURATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const ALL_KEYS = process.env.RAPIDAPI_KEYS_LIST.split(',');
// Database URL from GitHub Secrets
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
let currentKeyIndex = 0;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
});
const db = admin.database();

// --- 2. LOGOS & CONSTANTS ---
const LOGOS = {
    // Only SOCO Logo is needed now
    SOCO: "https://i.ibb.co/DgvNg0k0/1000315332.png"
};

// --- 3. HELPER FUNCTIONS ---

// Helper to format IST time exactly as specified
function getFormattedIstTime() {
    const d = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    const parts = formatter.formatToParts(d);
    let day = '', month = '', year = '2026', hour = '', minute = '', second = '', dayPeriod = '';
    parts.forEach(p => {
        if (p.type === 'day') day = p.value;
        else if (p.type === 'month') month = p.value;
        else if (p.type === 'year') year = "2026"; // Forced to 2026 as per script's force logic
        else if (p.type === 'hour') hour = p.value;
        else if (p.type === 'minute') minute = p.value;
        else if (p.type === 'second') second = p.value;
        else if (p.type === 'dayPeriod') dayPeriod = p.value.toUpperCase();
    });
    return `${hour}:${minute}:${second} ${dayPeriod} ${day}-${month}-${year}`;
}

// 🔥 IMPROVED NAME MATCHING LOGIC
function normalizeName(str) {
    if (!str) return "";
    
    // 1. Lowercase & Remove Accents
    let name = str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 2. Expand Common Abbreviations
    name = name.replace(/\batl\.?\b/g, "atletico");
    name = name.replace(/\butd\.?\b/g, "united");
    name = name.replace(/\bman\.?\b/g, "manchester");
    name = name.replace(/\bst\.?\b/g, "saint");
    name = name.replace(/\bint\.?\b/g, "inter");

    // 3. Remove Club Prefixes/Suffixes
    name = name.replace(/\b(fc|cf|sc|ac|rc|cd|as)\b/g, "");

    // 4. Remove ALL non-alphanumeric chars
    return name.replace(/[^a-z0-9]/g, "").trim();
}

function getBrandedName(sportCategory) {
    const sport = (sportCategory || "Football").toLowerCase();
    const base = "SPORTIFy";
    const adjectives = ["FAST", "PRO", "MAX", "ULTRA", "PLUS", "GOLD", "LIVE", "PRIME", "TURBO", "STAR"];
    const sportAdjs = sport.includes("cricket") ? ["CRICKET", "T20", "MATCH"] : ["FOOTBALL", "SOCCER", "GOAL"];
    const resolutions = ["HD", "FHD", "SD"];
    const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let selectedAdj = rand(adjectives);
    if (Math.random() < 0.3) selectedAdj = rand(sportAdjs);
    const style = Math.floor(Math.random() * 3);
    if (style === 0) return `${base} ${rand(resolutions)}`;
    if (style === 1) return `${base} ${selectedAdj}`;
    return `${base} ${selectedAdj} ${rand(resolutions)}`;
}

// 🔥 HELPER TO CREATE IFRAME STRING (EXACT FORMAT)
function createIframe(url) {
    return `<iframe src="https://trent-alexander-arnol.github.io/HLS-PLAYER/?play=${url}" style="width: 100%; aspect-ratio: 16/9; border: none;" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
}

async function fetchFromApi(page, dateStr) {
    if (currentKeyIndex >= ALL_KEYS.length) throw new Error("❌ ALL KEYS EXHAUSTED");
    
    try {
        const response = await axios.get(`https://football-live-streaming-api.p.rapidapi.com/matches`, {
            params: { page: page, date: dateStr },
            headers: {
                'x-rapidapi-key': ALL_KEYS[currentKeyIndex],
                'x-rapidapi-host': 'football-live-streaming-api.p.rapidapi.com'
            }
        });
        return response.data.matches || [];
    } catch (error) {
        if (error.response && (error.response.status === 429 || error.response.status === 401)) {
            console.log(`⚠️ Key ${currentKeyIndex} Failed. Switching...`);
            currentKeyIndex++;
            return fetchFromApi(page, dateStr);
        }
        return [];
    }
}

// --- 4. MAIN SYNC LOGIC ---
async function runSync() {
    console.log("⏰ Starting Sync (Pages 1 to 3) [ONLY SOCO + IFRAME MODE]...");
    
    // --- DATE LOGIC ---
    const d = new Date();
    const istOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false };
    let istHour = parseInt(d.toLocaleString('en-US', istOptions));
    
    if (istHour === 24) istHour = 0; // Fix 24:00 bug

    if (istHour >= 0 && istHour < 4) {
        console.log(`🌙 Midnight Mode (${istHour}:00 IST). Checking Previous Day.`);
        d.setDate(d.getDate() - 1);
    } else {
        console.log(`☀️ Normal Mode (${istHour}:00 IST). Checking Today.`);
    }

    // FORCE YEAR 2026
    d.setFullYear(2026);

    const dateOptions = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
    const dateStr = d.toLocaleDateString('en-GB', dateOptions).replace(/\//g, '');

    console.log(`📅 Final Scanning Date (IST): ${dateStr}`);

    try {
        // A. GET API DATA
        let rawApiMatches = [];
        for (let page = 1; page <= 3; page++) {
            const m = await fetchFromApi(page, dateStr);
            rawApiMatches = [...rawApiMatches, ...m];
        }
        
        console.log(`📊 Total Raw Matches Found: ${rawApiMatches.length}`);

        if (rawApiMatches.length === 0) { 
            console.log("No matches found in API."); 
            process.exit(0); 
        }

        // DEDUPLICATE MATCHES
        const bestMatchesMap = {};
        rawApiMatches.forEach(match => {
            const matchId = normalizeName(match.home_team_name) + "_vs_" + normalizeName(match.away_team_name);
            const serverCount = match.servers ? match.servers.length : 0;

            if (!bestMatchesMap[matchId]) {
                bestMatchesMap[matchId] = match;
            } else {
                const existingCount = bestMatchesMap[matchId].servers ? bestMatchesMap[matchId].servers.length : 0;
                if (serverCount > existingCount) {
                    bestMatchesMap[matchId] = match;
                }
            }
        });

        const allApiMatches = Object.values(bestMatchesMap);
        console.log(`✨ Unique Matches after Filter: ${allApiMatches.length}`);

        // --- FILTER ENDED, COUNT LIVE/UPCOMING & SAVE TO DATA.JSON ---
        const nowMs = Date.now();
        let liveCount = 0;
        let upcomingCount = 0;

        // Keep only Live and Upcoming matches (Skip matches ended more than 4 hours ago)
        const filteredEvents = allApiMatches.filter(match => {
            const matchTimeMs = match.match_time * 1000;
            return (matchTimeMs + 4 * 60 * 60 * 1000) > nowMs;
        });

        // 🔄 NEW UPDATE: COUNT LIVE AND UPCOMING MATCHES BASED ON MATCH STATUS FIELD
        filteredEvents.forEach(match => {
            const status = (match.match_status || "").toLowerCase();
            if (status === "live") {
                liveCount++;
            } else {
                upcomingCount++;
            }
        });

        // 🔄 NEW UPDATE: FORMAT & REORDER SERVERS ARRAY FOR DATA.JSON
        const formattedEvents = filteredEvents.map(match => {
            // Clone match object to avoid side effects during database synchronisation
            const clonedMatch = JSON.parse(JSON.stringify(match));
            
            if (clonedMatch.servers && Array.isArray(clonedMatch.servers)) {
                // Step 1: Clean and format servers based on type (direct, drm, referer)
                const processedServers = clonedMatch.servers.map(server => {
                    const typeLower = (server.type || "").toLowerCase();

                    if (typeLower === "direct") {
                        return {
                            name: server.name,
                            url: server.url,
                            type: server.type
                        };
                    } else if (typeLower === "drm") {
                        let cleanUrl = server.url || "";
                        let key = "";

                        if (cleanUrl.includes("|")) {
                            const parts = cleanUrl.split("|");
                            cleanUrl = parts[0]; // Cut URL at .mpd
                            const queryParams = parts[1] || "";
                            const licenseMatch = queryParams.match(/drmLicense=([^&]+)/);
                            if (licenseMatch) {
                                key = licenseMatch[1];
                            }
                        }

                        return {
                            name: server.name,
                            url: cleanUrl,
                            key: key,
                            type: server.type
                        };
                    } else {
                        // Referer or any other type remains completely untouched
                        return server;
                    }
                });

                // Step 2: Separate "pull.niues.live" links to move them to the top
                const socoServers = [];
                processedServers.forEach(server => {
                    const url = server.url || "";
                    if (url.includes("pull.niues.live")) {
                        socoServers.push(server);
                    }
                });

                // Take up to 2 pull.niues.live links
                const topSoco = socoServers.slice(0, 2);

                const finalSortedServers = [];
                // Put the top 2 pull.niues.live servers at the very beginning (index 0 and 1)
                finalSortedServers.push(...topSoco);

                // Add all other servers in their original sequence below them (Absolute preservation, no deletion)
                processedServers.forEach(server => {
                    const isAlreadyAdded = topSoco.some(ts => ts.url === server.url && ts.type === server.type);
                    if (!isAlreadyAdded) {
                        finalSortedServers.push(server);
                    }
                });

                // Step 3: Re-index server names sequentially ("Server 1", "Server 2", etc.)
                clonedMatch.servers = finalSortedServers.map((server, idx) => {
                    return {
                        ...server,
                        name: `Server ${idx + 1}`
                    };
                });
            }
            return clonedMatch;
        });

        const finalJsonOutput = {
            "NAME": "FluX-CR7 Live event ( Auto updated)",
            "AUTHOR": "iVan_Flux",
            "CONTACT (OWNER)": "https://t.me/iVan_flux",
            "TELEGRAM CHANNEL": "https://t.me/api_hub_by_ivan",
            "Last update time": getFormattedIstTime(),
            "Live": String(liveCount).padStart(2, '0'),
            "Upcoming": String(upcomingCount).padStart(2, '0'),
            "events": formattedEvents // Format-adjusted and sorted events inside "events" array [cite: 1.1]
        };

        // Write structured output to data.json locally
        fs.writeFileSync('data.json', JSON.stringify(finalJsonOutput, null, 2));
        console.log(`💾 Structured Live Event Data saved to 'data.json' in Repository.`);
        
        // B. GET DB DATA (Untouched)
        const dbMatches = (await db.ref('matches').once('value')).val() || {};
        let updateCount = 0;

        // C. PROCESS EACH MATCH FOR DATABASE (Untouched)
        for (const apiMatch of allApiMatches) {
            if (!apiMatch.servers || apiMatch.servers.length === 0) continue;

            const uiTeam1 = normalizeName(apiMatch.home_team_name);
            const uiTeam2 = normalizeName(apiMatch.away_team_name);
            let matchId = null;
            let currentStreams = [];

            // FIND MATCH
            for (const [key, val] of Object.entries(dbMatches)) {
                const dbCat = (val.sportType || "").toLowerCase();
                const apiCat = (apiMatch.sport_category || "Football").toLowerCase();
                if (dbCat !== apiCat) continue;

                const dbTeam1 = normalizeName(val.team1Name || "");
                const dbTeam2 = normalizeName(val.team2Name || "");

                if ((dbTeam1.includes(uiTeam1) || uiTeam1.includes(dbTeam1)) && 
                    (dbTeam2.includes(uiTeam2) || uiTeam2.includes(dbTeam2))) {
                    
                    if (Math.abs((apiMatch.match_time * 1000) - new Date(val.matchTime).getTime()) < 86400000) {
                        matchId = key;
                        currentStreams = val.streamLinks || [];
                        break;
                    }
                }
            }

            if (!matchId) continue; 

            // 🔥 CHANGED LOGIC: ONLY COLLECT SOCO LINKS
            let socoLinks = [];
            
            apiMatch.servers.forEach(s => {
                const url = s.url || "";
                
                // ONLY Check for SOCO (Ignore FMP/OK9)
                if (url.includes("pull.niues.live")) {
                    socoLinks.push({ url: url, type: "SOCO", logo: LOGOS.SOCO });
                }
            });

            // If no SOCO links found, skip match
            if (socoLinks.length === 0) continue;

            const sortedNewLinks = [...socoLinks]; 

            // PREPARE LIST
            let existingList = Array.isArray(currentStreams) ? [...currentStreams] : Object.values(currentStreams);
            existingList = existingList.filter(l => l);

            // Keep Manual Links (Top)
            const manualLinks = existingList.filter(link => link.source !== 'api');

            // Add New SOCO Links (Bottom) -> 🔥 CONVERT TO IFRAME + TYPE: EMBED
            const apiLinksToAdd = [];
            
            if (sortedNewLinks.length > 0) {
                apiLinksToAdd.push({ 
                    name: "SPORTIFy TV", 
                    link: createIframe(sortedNewLinks[0].url), // 👈 IFRAME HERE
                    type: "Embed", // 👈 TYPE CHANGED
                    logo: sortedNewLinks[0].logo, 
                    source: "api" 
                });
            }
            if (sortedNewLinks.length > 1) {
                apiLinksToAdd.push({ 
                    name: "SPORTIFy TV+ HD", 
                    link: createIframe(sortedNewLinks[1].url), // 👈 IFRAME HERE
                    type: "Embed", // 👈 TYPE CHANGED
                    logo: sortedNewLinks[1].logo, 
                    source: "api" 
                });
            }
            if (sortedNewLinks.length > 2) {
                for (let i = 2; i < sortedNewLinks.length; i++) {
                    const item = sortedNewLinks[i];
                    apiLinksToAdd.push({ 
                        name: getBrandedName(apiMatch.sport_category), 
                        link: createIframe(item.url), // 👈 IFRAME HERE
                        type: "Embed", // 👈 TYPE CHANGED
                        logo: item.logo, 
                        source: "api" 
                    });
                }
            }

            // MERGE
            const finalUpdatedList = [...manualLinks, ...apiLinksToAdd];

            await db.ref(`matches/${matchId}/streamLinks`).set(finalUpdatedList);
            
            console.log(`✅ Updated ${uiTeam1} vs ${uiTeam2} (SOCO=${socoLinks.length})`);
            updateCount++;
        }
        
        console.log(`🏁 Sync Done. Updated: ${updateCount} matches.`);
        process.exit(0);

    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
}

runSync();
