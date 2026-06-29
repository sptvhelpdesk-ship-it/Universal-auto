import os
import re
import sys
import json
import time
import random
import shutil
from datetime import datetime, timedelta
import pytz
from collections import OrderedDict
import cloudscraper

# --- সেটিংস ---
BASE_URL = os.getenv("BASE_URL")
OUTPUT_FILE = "Stream-Live.json"

def get_ist_time():
    ist = pytz.timezone('Asia/Kolkata')
    return datetime.now(ist).strftime('%d/%m/%y %H:%M:%S IST')

def log_to_console(message):
    """Prints logs to sys.stderr so they appear in GitHub Actions but do not pollute the raw JSON output."""
    print(message, file=sys.stderr)

def deduplicate(seq):
    """Helper function to remove duplicates while preserving order."""
    seen = set()
    return [x for x in seq if not (x in seen or seen.add(x))]

def push_to_github():
    log_to_console(f"[-] অন্য GitHub রিপোজিটরিতে {OUTPUT_FILE} আপডেট করা হচ্ছে...")
    GITHUB_TOKEN = os.getenv("GH_TOKEN")
    GITHUB_USER = os.getenv("TGITHUB_USER")
    GITHUB_REPO = os.getenv("TGITHUB_REPO")
    GITHUB_EMAIL = os.getenv("TGITHUB_EMAIL")
    
    temp_dir = "temp_external_repo"
    remote_url = f"https://{GITHUB_TOKEN}@github.com/{GITHUB_USER}/{GITHUB_REPO}.git"

    try:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
            
        clone_status = os.system(f"git clone {remote_url} {temp_dir}")
        if clone_status != 0:
            raise Exception("Git Clone ব্যর্থ হয়েছে। দয়া করে টোকেন ও রিপোজিটরি নাম চেক করুন।")
        
        shutil.copy(OUTPUT_FILE, os.path.join(temp_dir, OUTPUT_FILE))
        
        current_dir = os.getcwd()
        os.chdir(temp_dir)
        
        os.system(f'git config user.email "{GITHUB_EMAIL if GITHUB_EMAIL else "action@github.com"}"')
        os.system(f'git config user.name "{GITHUB_USER}"')
        os.system(f"git add {OUTPUT_FILE}")
        os.system(f'git commit -m "Auto Update: {get_ist_time()}" || echo "No changes"')
        push_status = os.system("git push origin main")
        
        os.chdir(current_dir)
        shutil.rmtree(temp_dir)
        
        if push_status == 0:
            log_to_console(f"[SUCCESS] অন্য রিপোজিটরিতে {OUTPUT_FILE} সফলভাবে আপডেট সম্পন্ন।")
        else:
            log_to_console("[ERROR] পুশ কমান্ড সফল হয়নি।")
            
    except Exception as e:
        log_to_console(f"[ERROR] পুশ ফেইল: {e}")

def extract_stream_token(scraper, player_url):
    """Fetches player page and extracts the unique stream token from iframe sources."""
    try:
        res = scraper.get(player_url, timeout=10)
        res.encoding = 'utf-8'  # Ensure proper decoding [cite: 2.1]
        html = res.text
        
        # Search for any stream parameter directly in the HTML
        stream_ids = re.findall(r'stream=([a-zA-Z0-9_.-]+)', html)
        if stream_ids:
            return deduplicate(stream_ids)
            
        # Fallback to scanning embedded iframe pages
        iframe_matches = re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', html, re.I)
        for iframe_url in iframe_matches:
            if not iframe_url.startswith('http'):
                if iframe_url.startswith('//'):
                    iframe_url = 'https:' + iframe_url
                else:
                    iframe_url = urljoin(player_url, iframe_url)
            
            time.sleep(random.uniform(0.3, 0.6))
            iframe_res = scraper.get(iframe_url, timeout=10)
            iframe_res.encoding = 'utf-8'  # Enforce UTF-8 [cite: 2.1]
            iframe_html = iframe_res.text
            
            inner_stream_ids = re.findall(r'stream=([a-zA-Z0-9_.-]+)', iframe_html)
            if inner_stream_ids:
                return deduplicate(inner_stream_ids)
                
    except Exception as e:
        log_to_console(f"    [!] Error during token extraction: {str(e)}")
    return []

def run_scraper():
    # Verify if BASE_URL secret is provided
    if not BASE_URL:
        error_package = OrderedDict([
            ("NAME", "FluX-CR7 Live event ( Auto updated)"),
            ("AUTHOR", "iVan_Flux"),
            ("CONTACT (OWNER)", "https://t.me/iVan_flux"),
            ("TELEGRAM CHANNEL", "https://t.me/api_hub_by_ivan"),
            ("Last update time", get_ist_time()),
            ("Live", "00"),
            ("Upcoming", "00"),
            ("events", [])
        ])
        print(json.dumps(error_package, indent=4, ensure_ascii=False))
        return

    # Use original configurations and API endpoints
    api_endpoint = "https://backend.streamcenter.live/api"
    api_parties_url = "https://backend.streamcenter.live/api/Parties?pageNumber=10&pageSize=500"

    scraper = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'android', 'desktop': False})
    raw_matches = []
    
    # Load categories Map from API
    categories_map = {}
    log_to_console("[*] Loading categories...")
    try:
        cats_res = scraper.get(f"{api_endpoint}/Categories", timeout=10)
        cats_res.encoding = 'utf-8'
        if cats_res.status_code == 200:
            categories = cats_res.json()
            for cat in categories:
                categories_map[cat.get("id")] = cat.get("name", "General")
            log_to_console(f"[+] Loaded {len(categories_map)} categories successfully.")
    except Exception as e:
        log_to_console(f"[WARNING] Categories load failed: {e}")

    # Fetch active parties from exact target API [1]
    log_to_console(f"\n[*] Loading matches from API: {api_parties_url}")
    try:
        games_res = scraper.get(api_parties_url, timeout=15)
        games_res.encoding = 'utf-8'
        if games_res.status_code != 200:
            log_to_console(f"[ERROR] API failed with status code: {games_res.status_code}")
            return
        games = games_res.json()
    except Exception as e:
        log_to_console(f"[ERROR] API Connection error: {e}")
        return

    log_to_console(f"[+] Found {len(games)} total scheduled matches.")
    log_to_console("-" * 50)

    # Filter active and upcoming matches across all categories
    for game in games:
        game_name = (game.get("name", "")).replace(" | ", " vs ").strip()
        cat_id = game.get("categoryId")
        cat_name = categories_map.get(cat_id, "General")
        game_id = game.get("id")
        
        # Skip finished/ended matches based on start time (if started more than 4 hours ago)
        begin_time_str = game.get("beginPartie") or game.get("date")
        if begin_time_str:
            try:
                if begin_time_str.endswith('Z'):
                    begin_time_str = begin_time_str[:-1] + '+00:00'
                match_dt = datetime.fromisoformat(begin_time_str)
                now_utc = datetime.now(pytz.utc)
                if match_dt + timedelta(hours=4) < now_utc:
                    continue  # Skip ended matches
            except Exception:
                pass
                
        player_urls = []
        
        # 1. Parse from videoUrl
        video_url_field = game.get("videoUrl")
        if video_url_field and isinstance(video_url_field, str):
            parts = video_url_field.split(";")
            for part in parts:
                url = part.split("<")[0].strip() if "<" in part else part.strip()
                if url:
                    url = url.replace("streams.center", "streamcenter.xyz")
                    player_urls.append(url)
                    
        # 2. Check stream arrays in object
        for key in ["streams", "servers"]:
            if key in game and isinstance(game[key], list):
                for s in game[key]:
                    url = s.get("url") or s.get("stream")
                    if url:
                        url = url.replace("streams.center", "streamcenter.xyz")
                        player_urls.append(url)

        # 3. Fetch fallback Parties/{id}/Servers endpoint
        try:
            srv_res = scraper.get(f"{api_endpoint}/Parties/{game_id}/Servers", timeout=10)
            srv_res.encoding = 'utf-8'
            if srv_res.status_code == 200:
                srv_data = srv_res.json()
                if isinstance(srv_data, list):
                    for s in srv_data:
                        url = s.get("url") or s.get("stream")
                        if url:
                            url = url.replace("streams.center", "streamcenter.xyz")
                            player_urls.append(url)
        except Exception:
            pass

        player_urls = deduplicate(player_urls)
        
        if player_urls:
            raw_matches.append({
                "cat_name": cat_name,
                "clean_rivals": game_name,
                "player_urls": player_urls,
                "raw_game": game
            })

    # Output generation
    all_live_matches = []
    log_to_console(f"\n[*] Extracting stream tokens for {len(raw_matches)} Baseball matches...")
    
    for item in raw_matches:
        log_to_console(f"[*] Processing Match: {item['clean_rivals']}")
        
        for s_idx, p_url in enumerate(item["player_urls"], 1):
            time.sleep(random.uniform(0.5, 1.0))
            
            # Extract unique tokens
            tokens = extract_stream_token(scraper, p_url)
            
            if tokens:
                for token in tokens:
                    # Construct stream url using mainstreams.pro with Referer header [1]
                    final_link = f"https://mainstreams.pro/hls/{token}.m3u8|Referer={BASE_URL}/"
                    log_to_console(f"      >>> [SUCCESS] Captured Token Stream: {final_link}")
                    
                    # Store original match fields exactly as returned from API inside events list/array
                    game_data = item["raw_game"].copy()
                    game_data["stream_server_id"] = f"S-{s_idx}"
                    game_data["formatted_stream_link"] = final_link
                    
                    all_live_matches.append(game_data)
            else:
                log_to_console(f"      >>> [FAILED] Could not find stream token from Server {s_idx}")

    # Process counts for Live and Upcoming dynamically
    now_utc = datetime.now(pytz.utc)
    live_count = 0
    upcoming_count = 0
    
    for game in all_live_matches:
        begin_time_str = game.get("beginPartie") or game.get("date")
        if begin_time_str:
            try:
                if begin_time_str.endswith('Z'):
                    begin_time_str = begin_time_str[:-1] + '+00:00'
                match_dt = datetime.fromisoformat(begin_time_str)
                if match_dt <= now_utc:
                    live_count += 1
                else:
                    upcoming_count += 1
            except Exception:
                pass

    # Structure final JSON package as requested [cite: 1.1]
    final_package = OrderedDict([
        ("NAME", "FluX-CR7 Live event ( Auto updated)"),
        ("AUTHOR", "iVan_Flux"),
        ("CONTACT (OWNER)", "https://t.me/iVan_flux"),
        ("TELEGRAM CHANNEL", "https://t.me/api_hub_by_ivan"),
        ("Last update time", datetime.now(pytz.timezone('Asia/Kolkata')).strftime('%I:%M:%S %p %d-%m-%Y')),
        ("Live", f"{live_count:02d}"),
        ("Upcoming", f"{upcoming_count:02d}"),
        ("events", all_live_matches) # Match data stored in events array [cite: 1.1]
    ])
    
    # Save output inside the Action runner using explicit UTF-8 encoding
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(final_package, f, indent=4, ensure_ascii=False)
    
    # Push to target repository
    push_to_github()
    
    # Print raw formatted JSON output to standard output only
    print(json.dumps(final_package, indent=4, ensure_ascii=False))

if __name__ == "__main__":
    run_scraper()
