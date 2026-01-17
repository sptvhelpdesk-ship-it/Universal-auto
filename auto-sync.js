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

// Name Normalizer (Matches your HTML Tool)
function normalizeName(str) {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(fc|cf|sc|ac|rc|cd)\b/g, "")
        .replace(/[^a-z0-9]/g, "")
        .trim();
}

// Random Name Generator for Extra Links
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

// API Fetch with Rotation
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

// Link Classifier
function getLinkType(url) {
    if (!url) return null;
    if (url.includes("fmp.live")) return "FMP"; // Logic: Referer usually needed, but here we just check availability
    // Note: API returns 'referer' header for FMP, but URL itself might not say fmp. 
    // We check headers from API object in main loop, here we just categorize for sorting if needed.
    // Better logic applied in main loop.
    return "UNKNOWN";
}

// --- 4. MAIN SYNC LOGIC ---
async function runSync() {
    console.log("⏰ Starting Sync (Pages 1 & 2)...");
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');

    try {
        // A. GET API DATA
        let allApiMatches = [];
        for (let page = 1; page <= 2; page++) {
            const m = await fetchFromApi(page, dateStr);
            allApiMatches = [...allApiMatches, ...m];
        }
        if (allApiMatches.length === 0) { console.log("No API matches."); process.exit(0); }

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

            // 1. FIND MATCH
            for (const [key, val] of Object.entries(dbMatches)) {
                const dbCat = (val.sportType || "").toLowerCase();
                const apiCat = (apiMatch.sport_category || "Football").toLowerCase();
                if (dbCat !== apiCat) continue;

                const dbTeam1 = normalizeName(val.team1Name || "");
                const dbTeam2 = normalizeName(val.team2Name || "");

                if ((dbTeam1.includes(uiTeam1) || uiTeam1.includes(dbTeam1)) && 
                    (dbTeam2.includes(uiTeam2) || uiTeam2.includes(dbTeam2))) {
                    
                    // Time Check (24h)
                    if (Math.abs((apiMatch.match_time * 1000) - new Date(val.matchTime).getTime()) < 86400000) {
                        matchId = key;
                        currentStreams = val.streamLinks || [];
                        break;
                    }
                }
            }

            if (!matchId) continue; // Skip if not found

            // 2. COLLECT & SORT VALID LINKS
            let fmpLinks = [], socoLinks = [], ok9Links = [];
            
            apiMatch.servers.forEach(s => {
                const headers = s.headers || {};
                const referer = headers.referer || "";
                const url = s.url || "";
                
                // PRIORITY 1: FMP
                if (referer.includes("fmp.live")) {
                    fmpLinks.push({ url: url, type: "FMP", logo: LOGOS.FMP });
                }
                // PRIORITY 2: SOCO
                else if (url.includes("pull.niues.live")) {
                    socoLinks.push({ url: url, type: "SOCO", logo: LOGOS.SOCO });
                }
                // PRIORITY 3: OK9
                else if (url.includes("cdnok9.com")) {
                    ok9Links.push({ url: url, type: "OK9", logo: LOGOS.OK9 });
                }
            });

            // Master List (Order: FMP -> SOCO -> OK9)
            const sortedNewLinks = [...fmpLinks, ...socoLinks, ...ok9Links];
            if (sortedNewLinks.length === 0) continue;

            // 3. PREPARE DB UPDATE
            // Convert DB streams to array if object
            let finalLinks = Array.isArray(currentStreams) ? [...currentStreams] : Object.values(currentStreams);
            // Filter nulls
            finalLinks = finalLinks.filter(l => l);

            // TRACK EXISTING URLS (To avoid duplicates)
            const existingUrls = new Set(finalLinks.map(l => l.link));
            
            // FIND TARGET INDICES (Last occurrences of specific names)
            let idxTv = -1;
            let idxHd = -1;
            
            // Search from end to start to find the last ones (as they are usually at bottom)
            for (let i = finalLinks.length - 1; i >= 0; i--) {
                if (finalLinks[i].name === "SPORTIFy TV" && idxTv === -1) idxTv = i;
                if (finalLinks[i].name === "SPORTIFy TV+ HD" && idxHd === -1) idxHd = i;
            }

            let usedLinkIndices = new Set(); // To track which new links are used for updates

            // --- STEP A: UPDATE TARGETS (First 2 Sorted Links) ---
            
            // Update SPORTIFy TV (with 1st new link)
            if (idxTv !== -1 && sortedNewLinks.length > 0) {
                const linkObj = sortedNewLinks[0];
                // Only update if URL is different
                if (finalLinks[idxTv].link !== linkObj.url) {
                    finalLinks[idxTv] = {
                        name: "SPORTIFy TV",
                        link: linkObj.url,
                        type: "Direct",
                        logo: linkObj.logo
                    };
                    usedLinkIndices.add(0); // Mark 1st link as used
                } else {
                    usedLinkIndices.add(0); // Even if same, mark used so we don't add again
                }
            }

            // Update SPORTIFy TV+ HD (with 2nd new link)
            if (idxHd !== -1 && sortedNewLinks.length > 1) {
                const linkObj = sortedNewLinks[1];
                if (finalLinks[idxHd].link !== linkObj.url) {
                    finalLinks[idxHd] = {
                        name: "SPORTIFy TV+ HD",
                        link: linkObj.url,
                        type: "Direct",
                        logo: linkObj.logo
                    };
                    usedLinkIndices.add(1);
                } else {
                    usedLinkIndices.add(1);
                }
            }

            // --- STEP B: APPEND REST (As New Links at End) ---
            let changesMade = (usedLinkIndices.size > 0); // Flag to check if we need to write DB
            
            sortedNewLinks.forEach((item, idx) => {
                // If this link was already used for update, skip
                if (usedLinkIndices.has(idx)) return;
                
                // DUPLICATE CHECK (Check if this URL exists anywhere else in DB list)
                // Note: We re-check existingUrls because we might have updated some above
                const currentUrls = new Set(finalLinks.map(l => l.link));
                if (currentUrls.has(item.url)) return;

                // ADD NEW
                const newName = getBrandedName(apiMatch.sport_category);
                finalLinks.push({
                    name: newName,
                    link: item.url,
                    type: "Direct",
                    logo: item.logo
                });
                changesMade = true;
            });

            // 4. WRITE TO DB
            if (changesMade) {
                await db.ref(`matches/${matchId}/streamLinks`).set(finalLinks);
                console.log(`✅ Updated ${uiTeam1} vs ${uiTeam2}`);
                updateCount++;
            }
        }
        
        console.log(`🏁 Sync Done. Updated: ${updateCount}`);
        process.exit(0);

    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
}

runSync();
