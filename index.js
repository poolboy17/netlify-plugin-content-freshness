/**
 * netlify-plugin-content-freshness
 *
 * Scans built article pages and:
 *   1. Injects JSON-LD Article structured data (datePublished + dateModified)
 *   2. Injects a visible freshness badge ("Last reviewed" or "Originally published")
 *   3. Logs a freshness report with stale articles flagged
 *
 * How it determines dates:
 *   - Looks for <time> or <meta> elements with pubDate / updatedDate info
 *   - Falls back to parsing visible date text in the article header
 *   - Uses file modification time as last resort
 *
 * Freshness logic:
 *   - Fresh: updatedDate within `freshnessMonths` (default 6) → "Last reviewed" badge
 *   - Stale: older than threshold → "Originally published" badge + deploy warning
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  freshnessMonths: 6,
  siteName: "Pro Trainer Prep",
  siteUrl: "",
  contentPaths: ["/blog/"],       // only scan pages under these paths
  ignorePaths: [],                // skip these specific paths
  injectJsonLd: true,
  injectBadge: true,
  badgePosition: "after-title",   // "after-title" or "before-content"
  failOnStale: false,
};

// ── Date extraction from HTML ────────────────────────────

function extractDatesFromHtml(html) {
  let pubDate = null;
  let updatedDate = null;

  // Method 1: <time datetime="..."> elements
  const timeRe = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi;
  const times = [];
  let m;
  while ((m = timeRe.exec(html)) !== null) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) times.push(d);
  }
  if (times.length >= 2) {
    pubDate = times[0];
    updatedDate = times[1];
  } else if (times.length === 1) {
    pubDate = times[0];
  }

  // Method 2: Parse visible date text (e.g., "February 8, 2026 · Reviews")
  if (!pubDate) {
    const dateTextRe = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/gi;
    const dateMatches = html.match(dateTextRe);
    if (dateMatches && dateMatches.length > 0) {
      const d = new Date(dateMatches[0]);
      if (!isNaN(d.getTime())) pubDate = d;
    }
  }

  // Method 3: meta article:published_time / article:modified_time
  const pubMeta = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
  if (pubMeta) {
    const d = new Date(pubMeta[1]);
    if (!isNaN(d.getTime())) pubDate = d;
  }
  const modMeta = html.match(/property=["']article:modified_time["'][^>]*content=["']([^"']+)["']/i);
  if (modMeta) {
    const d = new Date(modMeta[1]);
    if (!isNaN(d.getTime())) updatedDate = d;
  }

  return { pubDate, updatedDate };
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
}

function extractDescription(html) {
  const m = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  return m ? m[1].trim() : null;
}

// ── Badge HTML ───────────────────────────────────────────

function freshBadgeHtml(date) {
  const formatted = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `<div class="freshness-badge freshness-fresh" style="display:inline-flex;align-items:center;gap:0.4rem;background:#e6faf0;border:1px solid #00C878;border-radius:6px;padding:0.35rem 0.75rem;font-size:0.82rem;color:#1c1c20;margin-bottom:1rem;font-weight:600;">
  <span style="color:#00C878;">✓</span> Last reviewed ${formatted}
</div>`;
}

function staleBadgeHtml(date) {
  const formatted = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `<div class="freshness-badge freshness-stale" style="display:inline-flex;align-items:center;gap:0.4rem;background:#fff8e1;border:1px solid #f9a825;border-radius:6px;padding:0.35rem 0.75rem;font-size:0.82rem;color:#1c1c20;margin-bottom:1rem;font-weight:600;">
  <span style="color:#f9a825;">⏱</span> Originally published ${formatted} — review pending
</div>`;
}

// ── JSON-LD ──────────────────────────────────────────────

function articleJsonLd({ title, description, pubDate, updatedDate, urlPath, siteUrl, siteName, heroImage }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "description": description || "",
    "datePublished": pubDate.toISOString(),
    "dateModified": (updatedDate || pubDate).toISOString(),
    "publisher": {
      "@type": "Organization",
      "name": siteName,
    },
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": siteUrl ? `${siteUrl}${urlPath}` : urlPath,
    },
  };

  if (heroImage) {
    data.image = heroImage;
  }

  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function extractHeroImage(html) {
  // Look for first large image in article
  const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*style=["'][^"']*object-fit/i);
  return m ? m[1] : null;
}

// ── Main plugin ──────────────────────────────────────────
module.exports = {
  onPostBuild: async ({ constants, utils, inputs }) => {
    const publishDir = constants.PUBLISH_DIR;
    const config = { ...DEFAULTS, ...inputs };
    const siteUrl = (config.siteUrl || process.env.URL || "").replace(/\/$/, "");
    const now = new Date();
    const staleThreshold = new Date(now);
    staleThreshold.setMonth(staleThreshold.getMonth() - config.freshnessMonths);

    console.log("\n📅 Content Freshness Tracker — scanning articles...\n");
    console.log(`   Freshness threshold: ${config.freshnessMonths} months (before ${staleThreshold.toISOString().slice(0, 10)})\n`);

    // 1. Find HTML files in content paths
    const htmlFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".html")) htmlFiles.push(full);
      }
    }
    walk(publishDir);

    const contentFiles = htmlFiles.filter((f) => {
      const rel = "/" + path.relative(publishDir, f).replace(/\\/g, "/");
      const urlPath = rel.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
      return config.contentPaths.some((cp) => urlPath.startsWith(cp) && urlPath !== cp);
    });

    if (contentFiles.length === 0) {
      console.log("   No content pages found.\n");
      return;
    }

    console.log(`   Found ${contentFiles.length} content pages\n`);

    // 2. Process each file
    const results = [];
    let injected = 0;
    let staleCount = 0;

    for (const file of contentFiles) {
      const relPath = "/" + path.relative(publishDir, file).replace(/\\/g, "/");
      const urlPath = relPath.replace(/\/index\.html$/, "/").replace(/\.html$/, "");

      // Skip ignored paths
      if (config.ignorePaths.some((ip) => urlPath.startsWith(ip))) continue;

      let html = fs.readFileSync(file, "utf-8");
      let modified = false;

      // Extract dates
      const dates = extractDatesFromHtml(html);
      const title = extractTitle(html) || urlPath;
      const description = extractDescription(html);
      const heroImage = extractHeroImage(html);

      // Use file mtime as fallback
      if (!dates.pubDate) {
        const stat = fs.statSync(file);
        dates.pubDate = stat.mtime;
      }

      const effectiveDate = dates.updatedDate || dates.pubDate;
      const isFresh = effectiveDate >= staleThreshold;

      // ── Inject JSON-LD ──────────────────
      if (config.injectJsonLd && dates.pubDate) {
        // Check if JSON-LD already exists
        if (!html.includes('"@type":"Article"') && !html.includes('"@type": "Article"')) {
          const jsonLd = articleJsonLd({
            title,
            description,
            pubDate: dates.pubDate,
            updatedDate: dates.updatedDate,
            urlPath,
            siteUrl,
            siteName: config.siteName,
            heroImage,
          });
          html = html.replace(/<\/head>/i, `  ${jsonLd}\n</head>`);
          modified = true;
          injected++;
        }
      }

      // ── Inject freshness badge ──────────
      if (config.injectBadge && dates.pubDate) {
        // Don't double-inject
        if (!html.includes("freshness-badge")) {
          const badge = isFresh
            ? freshBadgeHtml(effectiveDate)
            : staleBadgeHtml(dates.pubDate);

          // Insert after the first </h1> tag (after-title position)
          if (config.badgePosition === "after-title") {
            html = html.replace(/<\/h1>/, `</h1>\n      ${badge}`);
          } else {
            // before-content: insert before the article prose
            html = html.replace(
              /<div class="affiliate-disclosure"/,
              `${badge}\n    <div class="affiliate-disclosure"`
            );
          }
          modified = true;
        }
      }

      if (modified) {
        fs.writeFileSync(file, html, "utf-8");
      }

      if (!isFresh) staleCount++;

      results.push({
        urlPath,
        title: title.substring(0, 50),
        pubDate: dates.pubDate,
        updatedDate: dates.updatedDate,
        effectiveDate,
        isFresh,
        daysSinceUpdate: Math.floor((now - effectiveDate) / (1000 * 60 * 60 * 24)),
      });
    }

    // 3. Report
    console.log("═══════════════════════════════════════════");
    console.log("   CONTENT FRESHNESS REPORT");
    console.log("═══════════════════════════════════════════\n");
    console.log(`   Articles scanned:  ${results.length}`);
    console.log(`   JSON-LD injected:  ${injected}`);
    console.log(`   Fresh articles:    ${results.length - staleCount}`);
    console.log(`   Stale articles:    ${staleCount}\n`);

    // Sort: stale first, then by days since update
    results.sort((a, b) => {
      if (a.isFresh !== b.isFresh) return a.isFresh ? 1 : -1;
      return b.daysSinceUpdate - a.daysSinceUpdate;
    });

    console.log("───────────────────────────────────────────");
    console.log("   ARTICLE FRESHNESS");
    console.log("───────────────────────────────────────────\n");

    for (const r of results) {
      const dateStr = r.effectiveDate.toISOString().slice(0, 10);
      const age = r.daysSinceUpdate === 0 ? "today" :
                  r.daysSinceUpdate === 1 ? "1 day ago" :
                  `${r.daysSinceUpdate} days ago`;
      const icon = r.isFresh ? "✅" : "⚠️";
      console.log(`   ${icon} ${r.urlPath.padEnd(50)} ${dateStr}  (${age})`);
    }
    console.log("");

    if (staleCount > 0) {
      console.log(`📋 ACTION NEEDED: ${staleCount} article(s) haven't been reviewed in ${config.freshnessMonths}+ months.`);
      console.log("   Update the content and set a new updatedDate in frontmatter.\n");

      if (config.failOnStale) {
        const staleList = results
          .filter((r) => !r.isFresh)
          .slice(0, 10)
          .map((r) => `${r.urlPath} (last updated: ${r.effectiveDate.toISOString().slice(0, 10)})`)
          .join("\n  • ");
        utils.build.failBuild(
          `Content Freshness: ${staleCount} stale article(s) need review:\n  • ${staleList}\n\nUpdate content and set updatedDate, or set failOnStale: false.`
        );
      }
    } else {
      console.log("✅ All content is fresh!\n");
    }
  },
};
