const admin = require("firebase-admin");
const axios = require("axios");

// --- 1. CONFIGURATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const ALL_KEYS = process.env.RAPIDAPI_KEYS_LIST.split(',');
let currentKeyIndex = 0;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://field-fever-b9791-default-rtdb.firebaseio.com"
});
const db = admin.database();

// --- 2. LOGOS & CONSTANTS ---
const LOGOS = {
    FMP: "https://i.ibb.co/CFsJDtb/1000315330.png",
    SOCO: "https://i.ibb.co/DgvNg0k0/1000315332.png",
    OK9: "https://i.ibb.co/k66hvS7j/1000313353.jpg"
};

// --- 3. HELPER FUNCTIONS ---

function normalizeName(str) {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(fc|cf|sc|ac|rc|cd)\b/g, "")
        .replace(/[^a-z0-9]/g, "")
        .trim();
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
    console.log("⏰ Starting Sync (Pages 1 to 3)...");
    
    // --- DATE LOGIC ---
    const d = new Date();
    const istOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false };
    const istHour = parseInt(d.toLocaleString('en-US', istOptions));
    
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
        // A. GET API DATA (PAGES 1, 2, 3)
        let rawApiMatches = [];
        for (let page = 1; page <= 3; page++) {
            const m = await fetchFromApi(page, dateStr);
            rawApiMatches = [...rawApiMatches, ...m];
        }
        
        console.log(`📊 Total Raw Matches Found (Pages 1-3): ${rawApiMatches.length}`);

        if (rawApiMatches.length === 0) { 
            console.log("No matches found in API."); 
            process.exit(0); 
        }

        // 🔥 STEP: SAVE FULL RAW JSON TO DATABASE (Backup)
        // This saves the exact data from API without any filter
        await db.ref('api_raw_data').set(rawApiMatches);
        console.log(`💾 Full Raw Data Saved to 'api_raw_data' in Database.`);

        // 🔥 STEP: DEDUPLICATE MATCHES (KEEP BEST ONE)
        const bestMatchesMap = {};

        rawApiMatches.forEach(match => {
            const matchId = normalizeName(match.home_team_name) + "_vs_" + normalizeName(match.away_team_name);
            const serverCount = match.servers ? match.servers.length : 0;

            if (!bestMatchesMap[matchId]) {
                bestMatchesMap[matchId] = match;
            } else {
                // Keep the one with MORE links
                const existingCount = bestMatchesMap[matchId].servers ? bestMatchesMap[matchId].servers.length : 0;
                if (serverCount > existingCount) {
                    bestMatchesMap[matchId] = match;
                }
            }
        });

        const allApiMatches = Object.values(bestMatchesMap);
        console.log(`✨ Unique Matches to Process: ${allApiMatches.length}`);

        // B. GET DB DATA
        const dbMatches = (await db.ref('matches').once('value')).val() || {};
        let updateCount = 0;

        // C. PROCESS EACH MATCH
        for (const apiMatch of allApiMatches) {
            if (!apiMatch.servers || apiMatch.servers.length === 0) continue;

            const uiTeam1 = normalizeName(apiMatch.home_team_name);
            const uiTeam2 = normalizeName(apiMatch.away_team_name);
            let matchId = null;
            let currentStreams = [];

            // 1. FIND MATCH IN DB
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

            // 2. COLLECT NEW LINKS
            let fmpLinks = [], socoLinks = [], ok9Links = [];
            
            apiMatch.servers.forEach(s => {
                const url = s.url || "";
                if (url.includes("fpm.sla.homes")) {
                    fmpLinks.push({ url: url, type: "FMP", logo: LOGOS.FMP });
                }
                else if (url.includes("pull.niues.live")) {
                    socoLinks.push({ url: url, type: "SOCO", logo: LOGOS.SOCO });
                }
                else if (url.includes("cdnok9.com")) {
                    ok9Links.push({ url: url, type: "OK9", logo: LOGOS.OK9 });
                }
            });

            // Sorted List: SOCO > OK9 > FMP
            const sortedNewLinks = [...socoLinks, ...ok9Links, ...fmpLinks];
            
            if (sortedNewLinks.length === 0) continue;

            // 3. PREPARE EXISTING LINKS (KEEP MANUAL LINKS SAFE)
            let existingList = Array.isArray(currentStreams) ? [...currentStreams] : Object.values(currentStreams);
            existingList = existingList.filter(l => l);

            // Keep ONLY Manual Links (Remove old API links to avoid duplication)
            // Manual links stay at the TOP
            const manualLinks = existingList.filter(link => link.source !== 'api');

            // 4. PREPARE NEW API LINKS
            const apiLinksToAdd = [];

            // Priority 1
            if (sortedNewLinks.length > 0) {
                apiLinksToAdd.push({
                    name: "SPORTIFy TV",
                    link: sortedNewLinks[0].url,
                    type: "Direct",
                    logo: sortedNewLinks[0].logo,
                    source: "api" 
                });
            }
            // Priority 2
            if (sortedNewLinks.length > 1) {
                apiLinksToAdd.push({
                    name: "SPORTIFy TV+ HD",
                    link: sortedNewLinks[1].url,
                    type: "Direct",
                    logo: sortedNewLinks[1].logo,
                    source: "api" 
                });
            }
            // Others
            if (sortedNewLinks.length > 2) {
                for (let i = 2; i < sortedNewLinks.length; i++) {
                    const item = sortedNewLinks[i];
                    const newName = getBrandedName(apiMatch.sport_category);
                    apiLinksToAdd.push({
                        name: newName,
                        link: item.url,
                        type: "Direct",
                        logo: item.logo,
                        source: "api"
                    });
                }
            }

            // 5. MERGE: MANUAL (TOP) + NEW API (BOTTOM)
            const finalUpdatedList = [...manualLinks, ...apiLinksToAdd];

            await db.ref(`matches/${matchId}/streamLinks`).set(finalUpdatedList);
            
            // LOG WITH COUNTS
            console.log(`✅ Updated ${uiTeam1} vs ${uiTeam2} (SOCO=${socoLinks.length}, OK9=${ok9Links.length}, FMP=${fmpLinks.length})`);
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
