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
    console.log("⏰ Starting Sync with DEBUG MODE...");
    
    // --- FORCE YEAR 2026 ---
    const d = new Date();
    d.setFullYear(2026); 
    const options = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
    const dateStr = d.toLocaleDateString('en-GB', options).replace(/\//g, '');

    console.log(`📅 Scanning Date (IST): ${dateStr}`);

    try {
        // A. GET API DATA
        let allApiMatches = [];
        for (let page = 1; page <= 2; page++) {
            const m = await fetchFromApi(page, dateStr);
            allApiMatches = [...allApiMatches, ...m];
        }
        
        console.log(`📊 API Matches Found: ${allApiMatches.length}`);

        if (allApiMatches.length === 0) { 
            console.log("No matches found in API."); 
            process.exit(0); 
        }

        // B. GET DB DATA
        const dbMatches = (await db.ref('matches').once('value')).val() || {};
        const dbKeys = Object.keys(dbMatches);
        console.log(`📂 DB Matches Found: ${dbKeys.length}`);

        let updateCount = 0;

        // C. PROCESS EACH MATCH
        for (const apiMatch of allApiMatches) {
            if (!apiMatch.servers || apiMatch.servers.length === 0) continue;

            const uiTeam1 = normalizeName(apiMatch.home_team_name);
            const uiTeam2 = normalizeName(apiMatch.away_team_name);
            
            // --- DEBUG LOG START ---
            console.log(`\n🔍 Checking API Match: "${uiTeam1}" vs "${uiTeam2}"`);
            // --- DEBUG LOG END ---

            let matchId = null;
            let currentStreams = [];

            // 1. FIND MATCH
            for (const [key, val] of Object.entries(dbMatches)) {
                const dbTeam1 = normalizeName(val.team1Name || "");
                const dbTeam2 = normalizeName(val.team2Name || "");
                
                // Compare logic
                const nameMatch = (dbTeam1.includes(uiTeam1) || uiTeam1.includes(dbTeam1)) && 
                                  (dbTeam2.includes(uiTeam2) || uiTeam2.includes(dbTeam2));
                
                if (nameMatch) {
                    // Check Time
                    const apiTime = apiMatch.match_time * 1000;
                    const dbTime = new Date(val.matchTime).getTime();
                    const diff = Math.abs(apiTime - dbTime);
                    const isTimeOk = diff < 86400000; // 24 hours

                    console.log(`   👉 Found Name Match in DB: "${dbTeam1}" vs "${dbTeam2}"`);
                    console.log(`      Time Diff: ${diff / 3600000} hours. Allowed: 24 hours.`);

                    if (isTimeOk) {
                        console.log("      ✅ MATCH CONFIRMED!");
                        matchId = key;
                        currentStreams = val.streamLinks || [];
                        break;
                    } else {
                        console.log("      ❌ Time Mismatch! Skipping.");
                    }
                }
            }

            if (!matchId) {
                console.log("   ❌ No matching game found in DB for this API match.");
                continue; 
            }

            // ... (Rest of the update logic remains same) ...
            
            // 2. COLLECT & SORT VALID LINKS
            let fmpLinks = [], socoLinks = [], ok9Links = [];
            
            apiMatch.servers.forEach(s => {
                const headers = s.headers || {};
                const referer = headers.referer || "";
                const url = s.url || "";
                
                if (referer.includes("fmp.live")) fmpLinks.push({ url: url, type: "FMP", logo: LOGOS.FMP });
                else if (url.includes("pull.niues.live")) socoLinks.push({ url: url, type: "SOCO", logo: LOGOS.SOCO });
                else if (url.includes("cdnok9.com")) ok9Links.push({ url: url, type: "OK9", logo: LOGOS.OK9 });
            });

            const sortedNewLinks = [...fmpLinks, ...socoLinks, ...ok9Links];
            
            if (sortedNewLinks.length === 0) {
                 console.log("      ⚠️ Match found, but no valid (FMP/Soco/OK9) links in API.");
                 continue;
            }

            // 3. PREPARE DB UPDATE
            let finalLinks = Array.isArray(currentStreams) ? [...currentStreams] : Object.values(currentStreams);
            finalLinks = finalLinks.filter(l => l);

            let idxTv = -1;
            let idxHd = -1;
            
            for (let i = finalLinks.length - 1; i >= 0; i--) {
                if (finalLinks[i].name === "SPORTIFy TV" && idxTv === -1) idxTv = i;
                if (finalLinks[i].name === "SPORTIFy TV+ HD" && idxHd === -1) idxHd = i;
            }

            let usedLinkIndices = new Set(); 

            if (idxTv !== -1 && sortedNewLinks.length > 0) {
                const linkObj = sortedNewLinks[0];
                if (finalLinks[idxTv].link !== linkObj.url) {
                    finalLinks[idxTv] = { name: "SPORTIFy TV", link: linkObj.url, type: "Direct", logo: linkObj.logo };
                    usedLinkIndices.add(0);
                } else usedLinkIndices.add(0);
            }

            if (idxHd !== -1 && sortedNewLinks.length > 1) {
                const linkObj = sortedNewLinks[1];
                if (finalLinks[idxHd].link !== linkObj.url) {
                    finalLinks[idxHd] = { name: "SPORTIFy TV+ HD", link: linkObj.url, type: "Direct", logo: linkObj.logo };
                    usedLinkIndices.add(1);
                } else usedLinkIndices.add(1);
            }

            let changesMade = (usedLinkIndices.size > 0);
            
            sortedNewLinks.forEach((item, idx) => {
                if (usedLinkIndices.has(idx)) return;
                const currentUrls = new Set(finalLinks.map(l => l.link));
                if (currentUrls.has(item.url)) return;
                const newName = getBrandedName(apiMatch.sport_category);
                finalLinks.push({ name: newName, link: item.url, type: "Direct", logo: item.logo });
                changesMade = true;
            });

            if (changesMade) {
                await db.ref(`matches/${matchId}/streamLinks`).set(finalLinks);
                console.log(`   🎉 SUCCESS: DB Updated for ${uiTeam1} vs ${uiTeam2}`);
                updateCount++;
            } else {
                console.log(`   ℹ️ Links already up to date.`);
            }
        }
        
        console.log(`\n🏁 Sync Done. Updated: ${updateCount} matches.`);
        process.exit(0);

    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
}

runSync();
