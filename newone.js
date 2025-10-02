#!/usr/bin/env node

/**
 * DISCLAIMER:
 * This script is provided for educational purposes only. LinkedIn's terms of service prohibit
 * scraping or any form of automated data collection. Using this script to scrape LinkedIn's data
 * is against their terms of service and can result in your account being banned.
 * Use this script at your own risk. The author is not responsible for any misuse of this script.
 */

import puppeteer from "puppeteer-core";
import { readFile, writeFile } from "fs/promises";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------------------------------------
// Helper function to replace waitForTimeout
// ---------------------------------------------------------------------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------
const CONFIG = {
  // Browserless.io configuration
  browserlessApiToken:
    process.env.BROWSERLESS_API_TOKEN || "YOUR_API_TOKEN_HERE",

  // Regional endpoints (choose one based on your location)
  // 'production-sfo' - San Francisco, USA (default)
  // 'production-lon' - London, UK
  // 'production-ams' - Amsterdam, NL
  browserlessRegion: process.env.BROWSERLESS_REGION || "production-sfo",

  // LinkedIn configuration
  userProfileUrl:
    "https://www.linkedin.com/in/harishkumark025/recent-activity/all/",
  cookiesFile: "./your_linkedin_cookies.txt",
  jsonFile: "./user_posts_extended.json",

  // Scraping parameters
  maxPosts: 20,
  maxScrollAttempts: 40,
  maxNoNewPostsInARow: 3,
  loadPauseTime: 4000, // milliseconds
  initialLoadTime: 5000,

  // Timeout settings
  navigationTimeout: 90000, // 90 seconds for slow pages

  // Stealth mode (helps with bot detection)
  stealthMode: true,
};

// ---------------------------------------------------------------------------------------
// Helper function to parse Netscape cookies format
// ---------------------------------------------------------------------------------------
async function loadCookiesFromFile(filePath) {
  try {
    const cookiesContent = await readFile(filePath, "utf-8");
    const cookies = [];

    const lines = cookiesContent.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments (except #HttpOnly_)
      if (
        !trimmedLine ||
        (trimmedLine.startsWith("#") && !trimmedLine.startsWith("#HttpOnly_"))
      ) {
        continue;
      }

      // Handle #HttpOnly_ prefix
      let processedLine = trimmedLine;
      if (processedLine.startsWith("#HttpOnly_")) {
        processedLine = processedLine.replace("#HttpOnly_", "");
      }

      const fields = processedLine.split("\t");

      if (fields.length === 7) {
        const [domain, flag, path, secure, expiration, name, value] = fields;

        // Remove surrounding quotes from value if present
        let cleanValue = value;
        if (cleanValue.startsWith('"') && cleanValue.endsWith('"')) {
          cleanValue = cleanValue.substring(1, cleanValue.length - 1);
        }

        // Clean domain - Puppeteer needs domain without leading dot
        let cleanDomain = domain;
        if (cleanDomain.startsWith(".")) {
          cleanDomain = cleanDomain.substring(1);
        }

        const cookie = {
          name: name,
          value: cleanValue,
          domain: cleanDomain,
          path: path,
          secure: secure.toUpperCase() === "TRUE",
          httpOnly: flag.toUpperCase() === "TRUE",
        };

        // Add expiry if it's a valid number
        if (
          expiration &&
          !isNaN(expiration) &&
          expiration !== "-1" &&
          expiration !== "0"
        ) {
          cookie.expires = parseInt(expiration);
        }

        cookies.push(cookie);
      }
    }

    console.log(`[*] Parsed ${cookies.length} cookies from file`);
    return cookies;
  } catch (error) {
    console.error(`[!] Error loading cookies from ${filePath}:`, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// Helper function to convert abbreviated numbers (e.g., "1K", "2.5M") to integers
// ---------------------------------------------------------------------------------------
function convertAbbreviatedToNumber(str) {
  if (!str) return 0;
  const s = String(str).toUpperCase().trim();

  if (s.includes("K")) {
    return Math.floor(parseFloat(s.replace("K", "")) * 1000);
  } else if (s.includes("M")) {
    return Math.floor(parseFloat(s.replace("M", "")) * 1000000);
  } else {
    // Try to parse as regular number
    const num = parseInt(s);
    return isNaN(num) ? 0 : num;
  }
}

// ---------------------------------------------------------------------------------------
// Robust navigation function with retry logic
// ---------------------------------------------------------------------------------------
async function navigateWithRetry(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[*] Navigation attempt ${attempt}/${maxRetries} to ${url}`);

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.navigationTimeout,
      });

      // Wait a bit for page to stabilize
      await delay(2000);

      // Check if we ended up on the right page
      const currentUrl = page.url();

      if (
        currentUrl.includes("/login") ||
        currentUrl.includes("/uas/login") ||
        currentUrl.includes("authwall")
      ) {
        throw new Error("Redirected to login page - authentication failed");
      }

      console.log(`[*] Successfully navigated to ${currentUrl}`);
      return response;
    } catch (error) {
      if (error.message.includes("detached Frame")) {
        console.warn(`[!] Detached frame error on attempt ${attempt}`);
        if (attempt < maxRetries) {
          console.log(`[*] Waiting 3 seconds before retry...`);
          await delay(3000);
          continue;
        }
      } else if (error.message.includes("authentication failed")) {
        throw error; // Don't retry auth failures
      }

      if (attempt === maxRetries) {
        throw error;
      }

      console.warn(
        `[!] Navigation failed on attempt ${attempt}: ${error.message}`
      );
      await delay(3000);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Function to extract post data from the page
// ---------------------------------------------------------------------------------------
async function extractPostsData(page, existingPostIds) {
  return await page.evaluate((existingIds) => {
    const posts = [];
    const postWrappers = document.querySelectorAll("div.feed-shared-update-v2");

    postWrappers.forEach((pw) => {
      // 1) Post ID & Post URL
      let postId = null;
      let postUrl = null;

      const detailLink = pw.querySelector(
        "a.update-components-mini-update-v2__link-to-details-page"
      );
      if (detailLink && detailLink.href) {
        postUrl = detailLink.href.trim();
        if (postUrl.includes("urn:li:activity:")) {
          const parts = postUrl.split("urn:li:activity:");
          postId = parts[parts.length - 1].replace(/\//g, "");
        }
      }

      // Also check data-urn attribute
      if (!postId) {
        const dataUrn = pw.getAttribute("data-urn") || "";
        if (dataUrn.includes("urn:li:activity:")) {
          postId = dataUrn.split("urn:li:activity:")[1];
        }
      }

      // Skip if no ID or already exists
      if (!postId || existingIds.includes(postId)) {
        return;
      }

      // Convert relative URL to absolute
      if (postUrl && postUrl.startsWith("/feed/update/")) {
        postUrl = "https://www.linkedin.com" + postUrl;
      }

      // 2) Post Author details
      let authorName = null;
      let authorProfileLink = null;
      let authorJobTitle = null;
      let postTime = null;

      const actorContainer = pw.querySelector(
        "div.update-components-actor__container"
      );
      if (actorContainer) {
        // Author name
        const nameTag = actorContainer.querySelector(
          'span.update-components-actor__title span[dir="ltr"]'
        );
        if (nameTag) {
          authorName = nameTag.textContent.trim();
        }

        // Profile link
        const actorLink = actorContainer.querySelector(
          "a.update-components-actor__meta-link"
        );
        if (actorLink && actorLink.href) {
          authorProfileLink = actorLink.href.trim();
          if (authorProfileLink.startsWith("/in/")) {
            authorProfileLink = "https://www.linkedin.com" + authorProfileLink;
          }
        }

        // Job title
        const jobTitleTag = actorContainer.querySelector(
          "span.update-components-actor__description"
        );
        if (jobTitleTag) {
          authorJobTitle = jobTitleTag.textContent.trim();
        }

        // Time posted
        const timeTag = actorContainer.querySelector(
          "span.update-components-actor__sub-description"
        );
        if (timeTag) {
          postTime = timeTag.textContent.trim();
        }
      }

      // 3) Post content
      let postContent = null;
      const contentDiv = pw.querySelector("div.update-components-text");
      if (contentDiv) {
        postContent = contentDiv.textContent.trim();
      }

      // 4) Reactions, Comments, Impressions
      let postReactions = 0;
      let postComments = 0;
      let postImpressions = 0;

      const socialCountsDiv = pw.querySelector(
        "div.social-details-social-counts"
      );
      if (socialCountsDiv) {
        // Reactions
        const reactionItem = socialCountsDiv.querySelector(
          "li.social-details-social-counts__reactions button"
        );
        if (reactionItem && reactionItem.getAttribute("aria-label")) {
          const rawReactions = reactionItem
            .getAttribute("aria-label")
            .split(" ")[0];
          postReactions = rawReactions;
        }

        // Comments
        const commentItem = socialCountsDiv.querySelector(
          "li.social-details-social-counts__comments button"
        );
        if (commentItem && commentItem.getAttribute("aria-label")) {
          const rawComments = commentItem
            .getAttribute("aria-label")
            .split(" ")[0];
          postComments = rawComments;
        }
      }

      // Impressions
      const impressionsSpan = pw.querySelector("span.analytics-entry-point");
      if (impressionsSpan) {
        const possibleText = impressionsSpan.textContent.trim();
        if (possibleText.toLowerCase().includes("impressions")) {
          const rawImpressions = possibleText
            .toLowerCase()
            .replace("impressions", "")
            .trim()
            .split(" ")[0];
          postImpressions = rawImpressions;
        }
      }

      posts.push({
        postId,
        postUrl: postUrl || "",
        authorName: authorName || "",
        authorProfileLink: authorProfileLink || "",
        authorJobTitle: authorJobTitle || "",
        postTime: postTime || "",
        postContent: postContent || "",
        postReactions,
        postComments,
        postImpressions,
      });
    });

    return posts;
  }, existingPostIds);
}

// ---------------------------------------------------------------------------------------
// Main scraping function
// ---------------------------------------------------------------------------------------
async function scrapeLinkedInPosts() {
  console.log("[*] Starting LinkedIn scraper with Browserless.io...");
  console.log(`[*] Region: ${CONFIG.browserlessRegion}`);

  let browser;
  let page;

  try {
    // Build Browserless WebSocket endpoint with token
    const wsEndpoint = `wss://${
      CONFIG.browserlessRegion
    }.browserless.io?token=${CONFIG.browserlessApiToken}${
      CONFIG.stealthMode ? "&stealth" : ""
    }`;

    console.log("[*] Connecting to Browserless...");

    // Connect to Browserless using puppeteer-core
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
    });

    console.log("[*] Connected to Browserless successfully!");

    // Create a new page
    page = await browser.newPage();

    // Set longer timeout for navigation
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);
    page.setDefaultTimeout(CONFIG.navigationTimeout);

    // Set viewport
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });

    // Set user agent to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    // Set extra HTTP headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Load cookies from file
    console.log(`[*] Loading cookies from ${CONFIG.cookiesFile}...`);
    const cookies = await loadCookiesFromFile(CONFIG.cookiesFile);

    // Filter cookies to only include linkedin.com domain
    const linkedinCookies = cookies.filter((cookie) =>
      cookie.domain.includes("linkedin.com")
    );

    console.log(`[*] Found ${linkedinCookies.length} LinkedIn cookies to set`);

    // SIMPLIFIED APPROACH: Navigate to homepage and set cookies in one go
    console.log("[*] Navigating to LinkedIn homepage...");
    await page.goto("https://www.linkedin.com/", {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.navigationTimeout,
    });

    console.log("[*] Homepage loaded, waiting for page to stabilize...");
    await delay(3000);

    // Now set cookies
    console.log("[*] Setting cookies...");
    let successfulCookies = 0;
    let failedCookies = 0;

    for (const cookie of linkedinCookies) {
      try {
        await page.setCookie(cookie);
        successfulCookies++;
      } catch (cookieError) {
        failedCookies++;
        console.warn(
          `[!] Failed to set cookie ${cookie.name}:`,
          cookieError.message
        );
      }
    }

    console.log(`[*] Successfully set ${successfulCookies} cookies`);
    if (failedCookies > 0) {
      console.log(`[!] Failed to set ${failedCookies} cookies`);
    }

    // Wait before navigating
    await delay(2000);

    // Navigate DIRECTLY to the target profile (skip intermediate /feed/ navigation)
    console.log(`[*] Navigating directly to target profile...`);
    await navigateWithRetry(page, CONFIG.userProfileUrl);

    // Check if we're actually on the profile page
    const currentUrl = page.url();
    console.log(`[*] Current URL: ${currentUrl}`);

    if (!currentUrl.includes("linkedin.com/in/")) {
      throw new Error(
        `Not on a LinkedIn profile page. Current URL: ${currentUrl}`
      );
    }

    // Verify login by checking for indicators
    console.log("[*] Verifying login status...");
    try {
      await page.waitForSelector(
        '#global-nav, nav[aria-label="Primary Navigation"], .global-nav, div.feed-shared-update-v2',
        {
          timeout: 15000,
        }
      );
      console.log("[*] ✓ Successfully authenticated and on profile page");
    } catch (error) {
      console.warn(
        "[!] Could not verify navigation elements, but continuing..."
      );
    }

    // Wait for initial page load
    console.log(`[*] Waiting ${CONFIG.initialLoadTime}ms for posts to load...`);
    await delay(CONFIG.initialLoadTime);

    // Start scraping
    const postsData = [];
    const uniquePostIds = new Set();
    let scrollAttempts = 0;
    let noNewPostsCount = 0;

    console.log("\n[*] ===== Starting Post Collection =====");
    console.log(`[*] Target: ${CONFIG.maxPosts} posts`);
    console.log(`[*] Max scroll attempts: ${CONFIG.maxScrollAttempts}`);
    console.log("");

    while (
      postsData.length < CONFIG.maxPosts &&
      scrollAttempts < CONFIG.maxScrollAttempts &&
      noNewPostsCount < CONFIG.maxNoNewPostsInARow
    ) {
      // Extract posts from current page state
      const extractedPosts = await extractPostsData(
        page,
        Array.from(uniquePostIds)
      );

      let newPostsInThisPass = 0;

      for (const post of extractedPosts) {
        if (!uniquePostIds.has(post.postId)) {
          uniquePostIds.add(post.postId);
          newPostsInThisPass++;

          // Convert abbreviated numbers
          const postReactions = convertAbbreviatedToNumber(post.postReactions);
          const postComments = convertAbbreviatedToNumber(post.postComments);
          const postImpressions = convertAbbreviatedToNumber(
            post.postImpressions
          );

          const dateCollected = new Date()
            .toISOString()
            .replace("T", " ")
            .substring(0, 19);

          const contentSnippet =
            post.postContent.length > 70
              ? post.postContent.substring(0, 70) + "..."
              : post.postContent || "[No content]";

          console.log(
            `[+] Post ${postsData.length + 1}/${CONFIG.maxPosts} - ID: ${
              post.postId
            }`
          );
          console.log(`    Author: ${post.authorName}`);
          console.log(`    Content: ${contentSnippet}`);
          console.log(
            `    Engagement: ${postReactions} reactions, ${postComments} comments, ${postImpressions} impressions`
          );

          const postDict = {
            Post_ID: post.postId || "",
            Post_URL: post.postUrl || "",
            Post_Author_Name: post.authorName || "",
            Post_Author_Profile: post.authorProfileLink || "",
            Post_Author_JobTitle: post.authorJobTitle || "",
            Post_Time: post.postTime || "",
            Post_Content: post.postContent || "",
            Post_Reactions: postReactions,
            Post_Comments: postComments,
            Post_Impressions: postImpressions,
            Date_Collected: dateCollected,
          };

          postsData.push(postDict);

          if (postsData.length >= CONFIG.maxPosts) {
            break;
          }
        }
      }

      // Track if we're making progress
      if (newPostsInThisPass === 0) {
        noNewPostsCount++;
        console.log(
          `[*] No new posts found in this scroll (${noNewPostsCount}/${CONFIG.maxNoNewPostsInARow})`
        );
      } else {
        noNewPostsCount = 0;
      }

      // Scroll if we need more posts
      if (
        postsData.length < CONFIG.maxPosts &&
        noNewPostsCount < CONFIG.maxNoNewPostsInARow
      ) {
        console.log(
          `[*] Scrolling... (attempt ${scrollAttempts + 1}/${
            CONFIG.maxScrollAttempts
          })`
        );

        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });

        await delay(CONFIG.loadPauseTime);
        scrollAttempts++;
      }
    }

    console.log(`\n[*] ===== Scraping Complete =====`);
    console.log(`[*] Total posts collected: ${postsData.length}`);
    console.log(`[*] Scroll attempts: ${scrollAttempts}`);

    // Save to JSON file
    await writeFile(
      CONFIG.jsonFile,
      JSON.stringify(postsData, null, 2),
      "utf-8"
    );

    console.log(`[*] Data saved to ${CONFIG.jsonFile}`);
  } catch (error) {
    console.error("\n[!] ===== Error Occurred =====");
    console.error("[!] Error:", error.message);
    console.error("[!] Stack trace:", error.stack);

    // Try to get current page info for debugging
    if (page) {
      try {
        const url = await page.url();
        console.error(`[!] Current page URL: ${url}`);
      } catch (e) {
        // Ignore errors getting debug info
      }
    }

    throw error;
  } finally {
    if (browser) {
      console.log("[*] Closing browser connection...");
      await browser.close();
      console.log("[*] Browser closed.");
    }
  }
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeLinkedInPosts()
    .then(() => {
      console.log("\n[*] ===== Script Completed Successfully! =====");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n[!] ===== Script Failed =====");
      console.error("[!]", error.message);
      process.exit(1);
    });
}
