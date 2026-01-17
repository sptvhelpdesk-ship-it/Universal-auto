const admin = require("firebase-admin");
const axios = require("axios");

// --- CONFIGURATION ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const ALL_KEYS = process.env.RAPIDAPI_KEYS_LIST.split(',');
let currentKeyIndex = 0;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://field-fever-b9791-default-rtdb.firebaseio.com"
});

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
            currentKeyIndex++;
            return fetchFromApi(page, dateStr);
        }
        return [];
    }
}

async function runSync() {
    console.log("🕵️‍♂️ STARTING DEEP INSPECTION...");
    
    // --- FORCE 2026 FOR TESTING ---
    const d = new Date();
    d.setFullYear(2026); 
    const options = { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' };
    const dateStr = d.toLocaleDateString('en-GB', options).replace(/\//g, '');
    console.log(`📅 Date: ${dateStr}`);

    // GET API DATA
    let allApiMatches = [];
    for (let page = 1; page <= 2; page++) {
        const m = await fetchFromApi(page, dateStr);
        allApiMatches = [...allApiMatches, ...m];
    }
    
    console.log(`📊 Total Matches from API: ${allApiMatches.length}`);

    if (allApiMatches.length === 0) {
        console.log("❌ No matches found.");
        process.exit(0);
    }

    console.log("\n👇 CHECKING FIRST 5 MATCHES FOR LINKS 👇");
    
    // Check first 5 matches only
    const limit = Math.min(allApiMatches.length, 5);
    for (let i = 0; i < limit; i++) {
        const m = allApiMatches[i];
        const serverCount = m.servers ? m.servers.length : 0;
        
        console.log(`------------------------------------------------`);
        console.log(`⚽ Match: ${m.home_team_name} vs ${m.away_team_name}`);
        console.log(`⏰ Time: ${m.match_time}`);
        
        if (serverCount > 0) {
            console.log(`✅ Links Found: ${serverCount}`);
            console.log(`🔗 Sample Link: ${m.servers[0].url}`);
        } else {
            console.log(`❌ Links Found: 0 (This is why update is 0)`);
        }
    }
    
    console.log(`------------------------------------------------`);
    process.exit(0);
}

runSync();
