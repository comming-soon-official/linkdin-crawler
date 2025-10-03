#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
DISCLAIMER:
This script is provided for educational purposes only. LinkedIn's terms of service prohibit
scraping or any form of automated data collection. Using this script to scrape LinkedIn's data
is against their terms of service and can result in your account being banned.
Use this script at your own risk. The author is not responsible for any misuse of this script.
"""

import time
import json
from datetime import datetime

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from bs4 import BeautifulSoup as bs

# ---------------------------------------------------------------------------------------
# Function to load cookies from a Netscape-format cookies.txt file into Selenium's browser
# ---------------------------------------------------------------------------------------
def load_cookies(browser, file_path):
    with open(file_path, 'r', encoding='utf-8') as file:
        for line in file:
            line = line.strip()
            if not line or line.startswith('#') and not line.startswith('#HttpOnly_'):
                continue
            # Handle #HttpOnly_ prefix
            if line.startswith('#HttpOnly_'):
                line = line.replace('#HttpOnly_', '')
            fields = line.split('\t')
            if len(fields) == 7:
                domain = fields[0]
                flag = fields[1]
                path = fields[2]
                secure = fields[3]
                expiration = fields[4]
                name = fields[5]
                value = fields[6]
                # Remove surrounding quotes from value if present
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                cookie_dict = {
                    'name': name,
                    'value': value,
                    'domain': domain,
                    'path': path,
                }
                if expiration.isdigit():
                    cookie_dict['expiry'] = int(expiration)
                # Selenium expects boolean for secure
                cookie_dict['secure'] = (secure.upper() == 'TRUE')
                try:
                    browser.add_cookie(cookie_dict)
                except Exception as e:
                    print(f"[!] Failed to add cookie {name}: {e}")

# ---------------------------------------------------------------------------------------
# Helper function to convert abbreviated reaction/comment strings (e.g., "1K") to integers
# ---------------------------------------------------------------------------------------
def convert_abbreviated_to_number(s):
    s = s.upper().strip()
    if 'K' in s:
        return int(float(s.replace('K', '')) * 1000)
    elif 'M' in s:
        return int(float(s.replace('M', '')) * 1000000)
    else:
        # If it's just a normal number or empty, attempt to parse it
        try:
            return int(s)
        except ValueError:
            return 0

# ---------------------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------------------
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import uvicorn

app = FastAPI()

class ScrapeRequest(BaseModel):
    profile_url: str
    num_posts: int

@app.post("/scrape")
def scrape_linkedin_posts(req: ScrapeRequest):
    try:
        # Use a fixed cookies file path (user must provide this file)
        cookies_file = "./your_linkedin_cookies.txt"
        # Call the refactored scraping function
        posts = scrape_posts(req.profile_url, cookies_file, req.num_posts)
        return {"posts": posts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def scrape_posts(user_profile_url, cookies_file, max_posts):
    # --------------------------------
    # Customize these variables
    # --------------------------------
    json_file = None  # Not used in API mode
    MAX_POSTS = max_posts                          # Increase to get enough unique posts
    MAX_SCROLL_ATTEMPTS = 40               # Increase how many times we scroll
    MAX_NO_NEW_POSTS_IN_A_ROW = 3          # If we see 3 scrolls with no new posts, stop
    
    # --------------------------------
    # Set up Chrome (headless) driver
    # --------------------------------
    chrome_options = Options()
    chrome_options.add_argument('--headless')
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    
    print("[*] Initializing Chrome driver...")
    browser = webdriver.Chrome(options=chrome_options)
    
    print("[*] Setting window size...")
    browser.set_window_size(1920, 1080)
    
    # --------------------------------
    # Log in by loading cookies
    # --------------------------------
    print(f"[*] Going to LinkedIn home page and loading cookies from {cookies_file} ...")
    browser.get('https://www.linkedin.com/')
    time.sleep(2)
    
    # Load cookies
    load_cookies(browser, cookies_file)
    
    # Refresh to apply cookies
    browser.refresh()
    print("[*] Cookies loaded; refreshing page to apply them...")
    
    # Ensure page is loaded
    try:
        WebDriverWait(browser, 20).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "#global-nav"))
        )
        print("[*] Successfully logged in (navigation bar found).")
    except TimeoutException:
        print("[!] Navigation bar not found after applying cookies. Exiting.")
        browser.quit()
        return
    
    # --------------------------------
    # Navigate to the desired profile
    # --------------------------------
    print(f"[*] Navigating to {user_profile_url} ...")
    browser.get(user_profile_url)
    time.sleep(5)  # Let the page load
    
    # Prepare JSON
    print(f"[*] Will create JSON file: {json_file}")
    posts_data = []
    
    # Use a set to track post IDs to avoid duplicates
    unique_post_ids = set()
    post_count = 0
    
    # Scroll parameters
    LOAD_PAUSE_TIME = 4
    scroll_attempts = 0
    no_new_posts_count = 0

    print("[*] Starting to scroll and collect post data...")
    while post_count < MAX_POSTS and scroll_attempts < MAX_SCROLL_ATTEMPTS and no_new_posts_count < MAX_NO_NEW_POSTS_IN_A_ROW:
        
        soup = bs(browser.page_source, "html.parser")
        
        # Each post is generally in an element: <div class="feed-shared-update-v2 ..."/>
        post_wrappers = soup.find_all("div", {"class": "feed-shared-update-v2"})
        
        new_posts_in_this_pass = 0  # track how many brand-new posts we discovered in this pass
        
        for pw in post_wrappers:
            # ---
            # 1) Post ID & Post URL
            # ---
            post_id = None
            post_url = None
            
            detail_link_tag = pw.find("a", {"class": "update-components-mini-update-v2__link-to-details-page"})
            if detail_link_tag and detail_link_tag.get("href"):
                post_url = detail_link_tag["href"].strip()
                if "urn:li:activity:" in post_url:
                    part = post_url.split("urn:li:activity:")[-1].replace("/", "")
                    post_id = part
            
            # Also check data-urn
            if not post_id:
                data_urn = pw.get("data-urn", "")
                if "urn:li:activity:" in data_urn:
                    post_id = data_urn.split("urn:li:activity:")[-1]
            
            # If we still can't find ID, skip
            if not post_id:
                continue
            
            # If we already have this post in our set, skip it
            if post_id in unique_post_ids:
                continue
            
            # Mark it as new
            unique_post_ids.add(post_id)
            new_posts_in_this_pass += 1

            # Convert relative URL to absolute
            if post_url and post_url.startswith("/feed/update/"):
                post_url = "https://www.linkedin.com" + post_url
            
            # ---
            # 2) Post Author name, profile link, job title, posted time
            # ---
            author_name = None
            author_profile_link = None
            author_jobtitle = None
            post_time = None
            
            actor_container = pw.find("div", {"class": "update-components-actor__container"})
            if actor_container:
                # Author name
                name_tag = actor_container.find("span", {"class": "update-components-actor__title"})
                if name_tag:
                    inner_span = name_tag.find("span", {"dir": "ltr"})
                    if inner_span:
                        author_name = inner_span.get_text(strip=True)
                
                # Profile link
                actor_link = actor_container.find("a", {"class": "update-components-actor__meta-link"})
                if actor_link and actor_link.get("href"):
                    author_profile_link = actor_link["href"].strip()
                    if author_profile_link.startswith("/in/"):
                        author_profile_link = "https://www.linkedin.com" + author_profile_link
                
                # Job title
                jobtitle_tag = actor_container.find("span", {"class": "update-components-actor__description"})
                if jobtitle_tag:
                    author_jobtitle = jobtitle_tag.get_text(strip=True)
                
                # Time posted
                time_tag = actor_container.find("span", {"class": "update-components-actor__sub-description"})
                if time_tag:
                    post_time = time_tag.get_text(strip=True)
            
            # ---
            # 3) Post content
            # ---
            post_content = None
            content_div = pw.find("div", {"class": "update-components-text"})
            if content_div:
                post_content = content_div.get_text(separator="\n", strip=True)
            
            # ---
            # 4) Reactions, Comments, Impressions
            # ---
            post_reactions = 0
            post_comments = 0
            post_impressions = 0
            
            social_counts_div = pw.find("div", {"class": "social-details-social-counts"})
            if social_counts_div:
                # Reactions
                reaction_item = social_counts_div.find("li", {"class": "social-details-social-counts__reactions"})
                if reaction_item:
                    button_tag = reaction_item.find("button")
                    if button_tag and button_tag.has_attr("aria-label"):
                        raw_reactions = button_tag["aria-label"].split(" ")[0]
                        post_reactions = convert_abbreviated_to_number(raw_reactions)
                
                # Comments
                comment_item = social_counts_div.find("li", {"class": "social-details-social-counts__comments"})
                if comment_item:
                    cbutton_tag = comment_item.find("button")
                    if cbutton_tag and cbutton_tag.has_attr("aria-label"):
                        raw_comments = cbutton_tag["aria-label"].split(" ")[0]
                        post_comments = convert_abbreviated_to_number(raw_comments)
            
            # Impressions
            impressions_span = pw.find("span", {"class": "analytics-entry-point"})
            if impressions_span:
                possible_text = impressions_span.get_text(strip=True)
                if "impressions" in possible_text.lower():
                    raw_impressions = possible_text.lower().replace("impressions", "").strip()
                    raw_impressions = raw_impressions.split(" ")[0]
                    post_impressions = convert_abbreviated_to_number(raw_impressions)
            
            date_collected = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
            
            # Print for debugging
            content_snippet = post_content[:70] + ('...' if len(post_content or '')>70 else '') if post_content else '[No content]'
            print(f"[+] Found new Post ID {post_id}. So far we have {post_count + 1} unique posts.")
            print(f"    URL: {post_url}")
            print(f"    Author: {author_name} | {author_profile_link}")
            print(f"    Content snippet: {content_snippet}")
            
            # Collect post data for JSON
            post_dict = {
                "Post_ID": post_id or "",
                "Post_URL": post_url or "",
                "Post_Author_Name": author_name or "",
                "Post_Author_Profile": author_profile_link or "",
                "Post_Author_JobTitle": author_jobtitle or "",
                "Post_Time": post_time or "",
                "Post_Content": post_content or "",
                "Post_Reactions": post_reactions,
                "Post_Comments": post_comments,
                "Post_Impressions": post_impressions,
                "Date_Collected": date_collected
            }
            posts_data.append(post_dict)
            
            # Increase final count
            post_count += 1
            if post_count >= MAX_POSTS:
                break
        
        # If we found no new posts in this pass, increment no_new_posts_count
        # otherwise reset it
        if new_posts_in_this_pass == 0:
            no_new_posts_count += 1
        else:
            no_new_posts_count = 0
        
        # Scroll further only if we haven't reached MAX_POSTS
        if post_count < MAX_POSTS:
            print("[*] Scrolling to load more posts...")
            browser.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(LOAD_PAUSE_TIME)
            scroll_attempts += 1
    
    print(f"[*] Finished after collecting {post_count} unique posts.")
    print("[*] Closing browser.")
    browser.quit()
    return posts_data

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Scrape LinkedIn posts from a public profile.")
    parser.add_argument('--profile_url', type=str, required=True, help='LinkedIn profile URL')
    parser.add_argument('--num_posts', type=int, default=5, help='Number of posts to scrape')
    parser.add_argument('--cookies_file', type=str, default='./your_linkedin_cookies.txt', help='Path to cookies.txt file')
    parser.add_argument('--output', type=str, default='posts.json', help='Output JSON file')
    args = parser.parse_args()

    posts = scrape_posts(args.profile_url, args.cookies_file, args.num_posts)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(posts, f, ensure_ascii=False, indent=2)
    print(f"[*] Saved {len(posts)} posts to {args.output}")

# If you want to run the API with: python scrape.py
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "cli":
        main()
    else:
        uvicorn.run("scrape:app", host="0.0.0.0", port=8000)