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
    console.log("⏰ Starting Sync (Pages 1 & 2)...");
    
    // --- INTELLIGENT DATE LOGIC (MIDNIGHT FIX) ---
    const d = new Date();
    
    // Get current hour in India (IST)
    const istOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false };
    const istHour = parseInt(d.toLocaleString('en-US', istOptions));
    
    // LOGIC: If time is between 00:00 (12 AM) and 04:00 (4 AM), assume it belongs to PREVIOUS DATE
    if (istHour >= 0 && istHour < 4) {
        console.log(`🌙 Late Night Detected (${istHour}:00 IST). Switching to Previous Day's Schedule.`);
        d.setDate(d.getDate() - 1);
    } else {
        console.log(`☀️ Normal Time (${istHour}:00 IST). Scanning Today's Schedule.`);
    }

    // Convert final date to DDMMYYYY format
    const dateOptions = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
    const dateStr = d.toLocaleDateString('en-GB', dateOptions).replace(/\//g, '');

    console.log(`📅 Final Scanning Date (IST): ${dateStr}`);

    try {
        // A. GET API DATA
        let allApiMatches = [];
        for (let page = 1; page <= 2; page++) {
            const m = await fetchFromApi(page, dateStr);
            allApiMatches = [...allApiMatches, ...m];
        }
        
        console.log(`📊 Total Matches Found on Page 1 & 2: ${allApiMatches.length}`);

        if (allApiMatches.length === 0) { 
            console.log("No matches found in API."); 
            process.exit(0); 
        }

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
                    
                    // Time Check: Match must be within 24 hours
                    if (Math.abs((apiMatch.match_time * 1000) - new Date(val.matchTime).getTime()) < 86400000) {
                        matchId = key;
                        currentStreams = val.streamLinks || [];
                        break;
                    }
                }
            }

            if (!matchId) continue; 

            // 2. COLLECT & SORT VALID LINKS
            let fmpLinks = [], socoLinks = [], ok9Links = [];
            
            apiMatch.servers.forEach(s => {
                const headers = s.headers || {};
                const referer = headers.referer || "";
                const url = s.url || "";
                
                if (referer.includes("fmp.live")) {
                    fmpLinks.push({ url: url, type: "FMP", logo: LOGOS.FMP });
                }
                else if (url.includes("pull.niues.live")) {
                    socoLinks.push({ url: url, type: "SOCO", logo: LOGOS.SOCO });
                }
                else if (url.includes("cdnok9.com")) {
                    ok9Links.push({ url: url, type: "OK9", logo: LOGOS.OK9 });
                }
            });

            const sortedNewLinks = [...fmpLinks, ...socoLinks, ...ok9Links];
            if (sortedNewLinks.length === 0) continue;

            // 3. PREPARE DB UPDATE
            let finalLinks = Array.isArray(currentStreams) ? [...currentStreams] : Object.values(currentStreams);
            finalLinks = finalLinks.filter(l => l);

            // Find targets (SPORTIFy TV & TV+ HD) typically at end
            let idxTv = -1;
            let idxHd = -1;
            
            for (let i = finalLinks.length - 1; i >= 0; i--) {
                if (finalLinks[i].name === "SPORTIFy TV" && idxTv === -1) idxTv = i;
                if (finalLinks[i].name === "SPORTIFy TV+ HD" && idxHd === -1) idxHd = i;
            }

            let usedLinkIndices = new Set(); 

            // UPDATE 1st Link
            if (idxTv !== -1 && sortedNewLinks.length > 0) {
                const linkObj = sortedNewLinks[0];
                if (finalLinks[idxTv].link !== linkObj.url) {
                    finalLinks[idxTv] = {
                        name: "SPORTIFy TV",
                        link: linkObj.url,
                        type: "Direct",
                        logo: linkObj.logo
                    };
                    usedLinkIndices.add(0);
                } else {
                    usedLinkIndices.add(0);
                }
            }

            // UPDATE 2nd Link
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

            // APPEND REST
            let changesMade = (usedLinkIndices.size > 0);
            
            sortedNewLinks.forEach((item, idx) => {
                if (usedLinkIndices.has(idx)) return;
                
                const currentUrls = new Set(finalLinks.map(l => l.link));
                if (currentUrls.has(item.url)) return;

                const newName = getBrandedName(apiMatch.sport_category);
                finalLinks.push({
                    name: newName,
                    link: item.url,
                    type: "Direct",
                    logo: item.logo
                });
                changesMade = true;
            });

            if (changesMade) {
                await db.ref(`matches/${matchId}/streamLinks`).set(finalLinks);
                console.log(`✅ Updated ${uiTeam1} vs ${uiTeam2}`);
                updateCount++;
            }
        }
        
        console.log(`🏁 Sync Done. Updated: ${updateCount} matches.`);
        process.exit(0);

    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
}

runSync();
