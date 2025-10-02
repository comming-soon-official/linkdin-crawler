const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const BROWSERLESS_API_KEY =
  process.env.BROWSERLESS_API_KEY ||
  "2TA24z3DoHzUfqpc7c0e79181d57649df566aa2da5125f5d0";
const BROWSERLESS_URL = `https://production-sfo.browserless.io/content?token=${BROWSERLESS_API_KEY}`;

app.post("/scrape-linkedin-posts", async (req, res) => {
  try {
    let { profileUrl, numberOfPosts = 5, cookies } = req.body;

    // If cookies is a string, parse it into array of objects
    if (typeof cookies === "string") {
      cookies = cookies.split(";").map((cookieStr) => {
        const [name, ...valParts] = cookieStr.trim().split("=");
        return {
          name: name.trim(),
          value: valParts.join("=").replace(/^"|"$/g, "").trim(),
          domain: ".linkedin.com",
          path: "/",
          httpOnly: false,
          secure: true,
        };
      });
    }

    console.log(
      `[${new Date().toISOString()}] Received request to scrape posts for:`,
      profileUrl
    );

    if (!profileUrl) {
      return res.status(400).json({ error: "profileUrl is required" });
    }

    console.log(
      `[${new Date().toISOString()}] Starting scrape for:`,
      profileUrl
    );
    // BrowserQL query to scrape LinkedIn posts
    const browserQLQuery = {
      url: profileUrl,
      gotoOptions: {
        waitUntil: "networkidle2",
      },
      waitForSelector: {
        selector: ".feed-shared-update-v2",
        timeout: 5000, // Reduced timeout to 5 seconds
      },
      // Add cookies if provided
      cookies: cookies
        ? cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || ".linkedin.com",
            path: cookie.path || "/",
            httpOnly: cookie.httpOnly || false,
            secure: cookie.secure || true,
          }))
        : undefined,
    };

    let response;
    try {
      // Make request to Browserless
      response = await axios.post(BROWSERLESS_URL, browserQLQuery, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 120000, // Increased timeout to 120 seconds
      });
    } catch (err) {
      if (
        err.response &&
        err.response.data &&
        err.response.data.message &&
        err.response.data.message.includes("Timeout")
      ) {
        return res.status(504).json({
          success: false,
          error:
            "Selector timeout: LinkedIn posts not found within 5 seconds. Check if cookies are valid and the profile is public.",
          details: err.response.data,
        });
      }
      throw err;
    }

    // The Browserless API will return the full HTML content of the page
    const html =
      response.data.data || response.data.html || response.data || "";

    // Extract post HTML blocks from the page
    const postHtmlBlocks = html.match(
      /<div[^>]*class=["'][^"']*feed-shared-update-v2[^"']*["'][^>]*>[\s\S]*?<\/div>/g
    );

    if (!postHtmlBlocks || postHtmlBlocks.length === 0) {
      console.log(
        `[${new Date().toISOString()}] No posts found for:`,
        profileUrl
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] Found ${
          postHtmlBlocks.length
        } posts for:`,
        profileUrl
      );
    }

    // Parse the posts from the HTML
    const posts = postHtmlBlocks.slice(0, numberOfPosts).map((block, index) => {
      // Extract text content (remove HTML tags)
      const textContent = block
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Try to extract basic information
      const postData = {
        id: index + 1,
        content: textContent.substring(0, 500), // First 500 chars
        timestamp: extractTimestamp(block),
        reactions: extractReactions(block),
        comments: extractComments(block),
        rawHtml: block, // Include raw HTML for further processing if needed
      };

      return postData;
    });

    console.log(
      `[${new Date().toISOString()}] Scraped ${posts.length} posts for:`,
      profileUrl
    );

    res.json({
      success: true,
      profileUrl,
      postsScraped: posts.length,
      posts,
    });
  } catch (error) {
    console.error("Scraping error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || "No additional details",
    });
  }
});

// Helper function to extract timestamp
function extractTimestamp(html) {
  const timeMatch = html.match(
    /(\d+[smhd])|(\d+\s*(second|minute|hour|day|week|month)s?\s*ago)/i
  );
  return timeMatch ? timeMatch[0] : "Unknown";
}

// Helper function to extract reaction count
function extractReactions(html) {
  const reactionMatch = html.match(/(\d+)\s*(reaction|like)/i);
  return reactionMatch ? parseInt(reactionMatch[1]) : 0;
}

// Helper function to extract comment count
function extractComments(html) {
  const commentMatch = html.match(/(\d+)\s*comment/i);
  return commentMatch ? parseInt(commentMatch[1]) : 0;
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "LinkedIn Post Scraper" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LinkedIn scraper service running on port ${PORT}`);
  console.log(`POST /scrape-linkedin-posts - Scrape LinkedIn posts`);
  console.log(`GET /health - Health check`);
});

module.exports = app;
