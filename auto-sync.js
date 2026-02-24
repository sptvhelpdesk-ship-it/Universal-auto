const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");

// --- 1. CONFIGURATION (SECURE FROM ENV) ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const ALL_KEYS = process.env.RAPIDAPI_KEYS_LIST.split(',');
let currentKeyIndex = 0;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: databaseURL
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
    if (currentKeyIndex >= ALL_KEYS.length) throw new Error("ALL KEYS EXHAUSTED");

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
            console.log(`Key ${currentKeyIndex} Failed. Switching...`);
            currentKeyIndex++;
            return fetchFromApi(page, dateStr);
        }
        return [];
    }
}

// --- 4. MAIN SYNC LOGIC ---
async function runSync() {
    console.log("Starting Sync...");

    const d = new Date();
    const istOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false };
    let istHour = parseInt(d.toLocaleString('en-US', istOptions));

    if (istHour === 24) istHour = 0;

    if (istHour >= 0 && istHour < 4) {
        d.setDate(d.getDate() - 1);
    }

    d.setFullYear(2026);

    const dateOptions = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
    const dateStr = d.toLocaleDateString('en-GB', dateOptions).replace(/\//g, '');

    let rawApiMatches = [];

    for (let page = 1; page <= 3; page++) {
        const m = await fetchFromApi(page, dateStr);
        rawApiMatches = [...rawApiMatches, ...m];
    }

    if (rawApiMatches.length === 0) {
        console.log("No matches found.");
        process.exit(0);
    }

    fs.writeFileSync('data.json', JSON.stringify(rawApiMatches, null, 2));

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
    const dbMatches = (await db.ref('matches').once('value')).val() || {};
    let updateCount = 0;

    for (const apiMatch of allApiMatches) {
        if (!apiMatch.servers || apiMatch.servers.length === 0) continue;

        const uiTeam1 = normalizeName(apiMatch.home_team_name);
        const uiTeam2 = normalizeName(apiMatch.away_team_name);

        let matchId = null;
        let currentStreams = [];

        for (const [key, val] of Object.entries(dbMatches)) {
            const dbTeam1 = normalizeName(val.team1Name || "");
            const dbTeam2 = normalizeName(val.team2Name || "");

            if ((dbTeam1.includes(uiTeam1) || uiTeam1.includes(dbTeam1)) &&
                (dbTeam2.includes(uiTeam2) || uiTeam2.includes(dbTeam2))) {
                matchId = key;
                currentStreams = val.streamLinks || [];
                break;
            }
        }

        if (!matchId) continue;

        let existingList = Array.isArray(currentStreams)
            ? [...currentStreams]
            : Object.values(currentStreams);

        existingList = existingList.filter(l => l);
        await db.ref(`matches/${matchId}/streamLinks`).set(existingList);

        updateCount++;
    }

    console.log(`Sync Done. Updated: ${updateCount} matches.`);
    process.exit(0);
}

runSync();
