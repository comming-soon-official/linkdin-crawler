#!/usr/bin/env node

/**
 * DISCLAIMER:
 * This script is provided for educational purposes only. LinkedIn's terms of service prohibit
 * scraping or any form of automated data collection. Using this script to scrape LinkedIn's data
 * is against their terms of service and can result in your account being banned.
 * Use this script at your own risk. The author is not responsible for any misuse of this script.
 */

const fs = require("fs").promises;
const axios = require("axios");
const { JSDOM } = require("jsdom");

// ---------------------------------------------------------------------------------------
// Helper function to convert abbreviated reaction/comment strings (e.g., "1K") to integers
// ---------------------------------------------------------------------------------------
function convertAbbreviatedToNumber(s) {
  s = s.toUpperCase().trim();
  if (s.includes("K")) {
    return parseInt(parseFloat(s.replace("K", "")) * 1000);
  } else if (s.includes("M")) {
    return parseInt(parseFloat(s.replace("M", "")) * 1000000);
  } else {
    try {
      return parseInt(s) || 0;
    } catch (e) {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Load cookies from Netscape format file
// ---------------------------------------------------------------------------------------
async function loadCookiesFromFile(filePath) {
  const cookies = [];
  const fileContent = await fs.readFile(filePath, "utf-8");
  const lines = fileContent.split("\n");

  for (let line of lines) {
    line = line.trim();

    // Skip empty lines and comments (except HttpOnly)
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) {
      continue;
    }

    // Handle #HttpOnly_ prefix
    if (line.startsWith("#HttpOnly_")) {
      line = line.replace("#HttpOnly_", "");
    }

    const fields = line.split("\t");

    if (fields.length === 7) {
      const [domain, flag, path, secure, expiration, name, value] = fields;

      // Remove surrounding quotes from value if present
      let cookieValue = value;
      if (cookieValue.startsWith('"') && cookieValue.endsWith('"')) {
        cookieValue = cookieValue.slice(1, -1);
      }

      const cookieDict = {
        name: name,
        value: cookieValue,
        domain: domain,
        path: path,
        secure: secure.toUpperCase() === "TRUE",
      };

      // Add expiration if it's a valid number
      if (!isNaN(expiration) && expiration !== "") {
        cookieDict.expires = parseInt(expiration);
      }

      cookies.push(cookieDict);
    }
  }

  return cookies;
}

// ---------------------------------------------------------------------------------------
// Parse posts from HTML
// ---------------------------------------------------------------------------------------
function parsePosts(htmlContent) {
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  const postsData = [];

  const postWrappers = document.querySelectorAll("div.feed-shared-update-v2");
  console.log(`[*] Found ${postWrappers.length} post elements in the page`);

  postWrappers.forEach((pw) => {
    // Post ID & URL
    let postId = null;
    let postUrl = null;

    const detailLinkTag = pw.querySelector(
      "a.update-components-mini-update-v2__link-to-details-page"
    );
    if (detailLinkTag && detailLinkTag.href) {
      postUrl = detailLinkTag.href.trim();
      if (postUrl.includes("urn:li:activity:")) {
        const part = postUrl.split("urn:li:activity:")[1].replace(/\//g, "");
        postId = part;
      }
    }

    if (!postId) {
      const dataUrn = pw.getAttribute("data-urn") || "";
      if (dataUrn.includes("urn:li:activity:")) {
        postId = dataUrn.split("urn:li:activity:")[1];
      }
    }

    if (!postId) {
      return; // Skip this post
    }

    if (postUrl && postUrl.startsWith("/feed/update/")) {
      postUrl = "https://www.linkedin.com" + postUrl;
    }

    // Author info
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
        "span.update-components-actor__title"
      );
      if (nameTag) {
        const innerSpan = nameTag.querySelector('span[dir="ltr"]');
        if (innerSpan) {
          authorName = innerSpan.textContent.trim();
        }
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

    // Post content
    let postContent = null;
    const contentDiv = pw.querySelector("div.update-components-text");
    if (contentDiv) {
      postContent = contentDiv.textContent.trim();
    }

    // Engagement metrics
    let postReactions = 0;
    let postComments = 0;
    let postImpressions = 0;

    const socialCountsDiv = pw.querySelector(
      "div.social-details-social-counts"
    );
    if (socialCountsDiv) {
      // Reactions
      const reactionItem = socialCountsDiv.querySelector(
        "li.social-details-social-counts__reactions"
      );
      if (reactionItem) {
        const buttonTag = reactionItem.querySelector("button");
        if (buttonTag && buttonTag.hasAttribute("aria-label")) {
          const rawReactions = buttonTag
            .getAttribute("aria-label")
            .split(" ")[0];
          postReactions = convertAbbreviatedToNumber(rawReactions);
        }
      }

      // Comments
      const commentItem = socialCountsDiv.querySelector(
        "li.social-details-social-counts__comments"
      );
      if (commentItem) {
        const cButtonTag = commentItem.querySelector("button");
        if (cButtonTag && cButtonTag.hasAttribute("aria-label")) {
          const rawComments = cButtonTag
            .getAttribute("aria-label")
            .split(" ")[0];
          postComments = convertAbbreviatedToNumber(rawComments);
        }
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
        postImpressions = convertAbbreviatedToNumber(rawImpressions);
      }
    }

    const dateCollected = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);

    const contentSnippet = postContent
      ? postContent.substring(0, 70) + (postContent.length > 70 ? "..." : "")
      : "[No content]";

    console.log(`[+] Parsed Post ID: ${postId}`);
    console.log(`    Author: ${authorName}`);
    console.log(`    Content: ${contentSnippet}`);

    const postDict = {
      Post_ID: postId || "",
      Post_URL: postUrl || "",
      Post_Author_Name: authorName || "",
      Post_Author_Profile: authorProfileLink || "",
      Post_Author_JobTitle: authorJobTitle || "",
      Post_Time: postTime || "",
      Post_Content: postContent || "",
      Post_Reactions: postReactions,
      Post_Comments: postComments,
      Post_Impressions: postImpressions,
      Date_Collected: dateCollected,
    };

    postsData.push(postDict);
  });

  return postsData;
}

// ---------------------------------------------------------------------------------------
// Main script using Browserless /content API
// ---------------------------------------------------------------------------------------
async function main() {
  // Configuration
  const BROWSERLESS_API_KEY =
    "2TA24z3DoHzUfqpc7c0e79181d57649df566aa2da5125f5d0";
  const BROWSERLESS_URL = `https://production-sfo.browserless.io/content?token=${BROWSERLESS_API_KEY}`;

  const userProfileUrl =
    "https://www.linkedin.com/in/harishkumark025/recent-activity/all/";
  const cookiesFile = "./your_linkedin_cookies.txt";
  const jsonFile = "./user_posts_extended.json";

  try {
    console.log("[*] Loading cookies from file...");
    const cookies = await loadCookiesFromFile(cookiesFile);
    console.log(`[*] Loaded ${cookies.length} cookies`);

    // Prepare request payload
    const payload = {
      url: userProfileUrl,
      cookies: cookies,
      userAgent: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        platform: "desktop",
      },
      setJavaScriptEnabled: true,
      gotoOptions: {
        waitUntil: "networkidle2",
      },
    };

    console.log(`[*] Sending request to Browserless for ${userProfileUrl}...`);

    const response = await axios.post(BROWSERLESS_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });

    if (response.status === 200) {
      console.log("[*] Successfully retrieved page content!");
      const htmlContent = response.data;

      // Parse posts
      console.log("[*] Parsing posts...");
      const postsData = parsePosts(htmlContent);

      // Save to JSON
      await fs.writeFile(jsonFile, JSON.stringify(postsData, null, 2), "utf-8");

      console.log(`[*] Successfully scraped ${postsData.length} posts`);
      console.log(`[*] Data saved to ${jsonFile}`);
    } else {
      console.error(`[!] Error: ${response.status}`);
      console.error(`[!] Response: ${response.data}`);
    }
  } catch (error) {
    if (error.response) {
      console.error(`[!] Request failed with status ${error.response.status}`);
      console.error(`[!] Response: ${error.response.data}`);
    } else {
      console.error(`[!] Request failed: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Alternative: Using /scrape endpoint with custom JavaScript
// ---------------------------------------------------------------------------------------
async function mainWithScrapeEndpoint() {
  const BROWSERLESS_API_KEY = "YOUR_BROWSERLESS_API_KEY";
  const BROWSERLESS_URL = `https://chrome.browserless.io/scrape?token=${BROWSERLESS_API_KEY}`;

  const userProfileUrl =
    "https://www.linkedin.com/in/harishkumark025/recent-activity/all/";
  const cookiesFile = "./your_linkedin_cookies.txt";
  const jsonFile = "./user_posts_extended.json";

  try {
    const cookies = await loadCookiesFromFile(cookiesFile);

    const payload = {
      url: userProfileUrl,
      cookies: cookies,
      elements: [
        {
          selector: "div.feed-shared-update-v2",
        },
      ],
      waitFor: 3000,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };

    console.log("[*] Sending scrape request to Browserless...");

    const response = await axios.post(BROWSERLESS_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });

    if (response.status === 200) {
      const data = response.data;
      console.log(`[*] Found ${data.data?.length || 0} elements`);

      if (data.data && data.data.length > 0) {
        const fullHtml = data.data[0].html || "";
        const postsData = parsePosts(fullHtml);

        await fs.writeFile(
          jsonFile,
          JSON.stringify(postsData, null, 2),
          "utf-8"
        );

        console.log(`[*] Scraped ${postsData.length} posts`);
        console.log(`[*] Data saved to ${jsonFile}`);
      }
    } else {
      console.error(`[!] Error: ${response.status}`);
      console.error(`[!] Response: ${response.data}`);
    }
  } catch (error) {
    console.error(`[!] Error: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------
if (require.main === module) {
  // Choose which method to use:
  main(); // Uses /content endpoint (simpler, returns full HTML)
  // mainWithScrapeEndpoint(); // Uses /scrape endpoint (more targeted)
}

module.exports = {
  main,
  mainWithScrapeEndpoint,
  parsePosts,
  loadCookiesFromFile,
};
