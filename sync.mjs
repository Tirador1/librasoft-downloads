// LibraSoft downloads mirror — sync job.
//
// Runs in GitHub Actions (see .github/workflows/sync.yml). For each file listed
// on the legacy server's downloads.html it:
//   1. HEADs the source to read size + Last-Modified (cheap change detection),
//   2. re-downloads + re-uploads to this repo's Release ONLY when changed,
//   3. pushes the resulting HTTPS GitHub URLs into Convex (downloadLinks).
//
// Safety: the current Release asset keeps serving until a new one is fully
// uploaded; a file that fails to fetch falls back to its previous mirrored URL
// so a transient outage never drops a working link. If the index can't be
// parsed at all, we abort without touching Convex.
//
// Pure Node built-ins + the `gh` CLI (preinstalled on the runner). No npm deps.

import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const SOURCE_INDEX_URL = process.env.SOURCE_INDEX_URL || "http://librasoft.us/downloads.html";
const RELEASE_TAG = process.env.RELEASE_TAG || "files";
const MIRROR_REPO = process.env.MIRROR_REPO; // "owner/repo" — from github.repository
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL; // https://<deployment>.convex.site
const SYNC_SECRET = process.env.DOWNLOADS_SYNC_SECRET;
const MANIFEST_PATH = join(process.cwd(), "manifest.json");

if (!MIRROR_REPO) fail("MIRROR_REPO env is required");

// --- HTML parser (ported from the app's parseLibrasoftDownloads.ts) ---------
const CATEGORIES = ["libra", "companion", "additional"];

function parseDownloadsHtml(html) {
  const links = [];
  const sections = html.split("<thead>");

  for (let i = 1; i < sections.length && i <= 3; i++) {
    const section = sections[i];
    const category = CATEGORIES[i - 1];

    const tbodyMatch = section.match(/<tbody>([\s\S]*?)(?:<\/tbody>|<thead>)/);
    if (!tbodyMatch) continue;

    const rows = tbodyMatch[1].match(/<tr>[\s\S]*?<\/tr>/g);
    if (!rows) continue;

    let sortOrder = 1;
    for (const row of rows) {
      const hrefMatch = row.match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      const sourceUrl = hrefMatch[1];
      if (!/\/ver\//.test(sourceUrl)) continue; // only real download links

      const tdMatch = row.match(/<td>([\s\S]*?)<\/td>/);
      const tdContent = tdMatch ? tdMatch[1] : "";
      const labelAr = tdContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const englishMatch = tdContent.match(/\(\s*([A-Za-z0-9\s._\-+]+(?:\s+\d+[A-Za-z\s]*)?)\s*\)/);
      const label = englishMatch ? englishMatch[1].trim() : "";

      links.push({
        sourceUrl,
        assetName: basename(new URL(sourceUrl).pathname),
        label,
        labelAr: labelAr || basename(sourceUrl),
        category,
        sortOrder: sortOrder++,
      });
    }
  }
  return links;
}

// --- helpers ----------------------------------------------------------------
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function ensureRelease() {
  try {
    gh(["release", "view", RELEASE_TAG, "--repo", MIRROR_REPO]);
  } catch {
    console.log(`Creating release "${RELEASE_TAG}"…`);
    gh([
      "release", "create", RELEASE_TAG,
      "--repo", MIRROR_REPO,
      "--title", "LibraSoft Downloads",
      "--notes", "Mirrored installers, kept in sync with the legacy server.",
    ]);
  }
}

function assetUrl(assetName) {
  return `https://github.com/${MIRROR_REPO}/releases/download/${RELEASE_TAG}/${encodeURIComponent(assetName)}`;
}

async function headSource(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) throw new Error(`HEAD ${url} → ${res.status}`);
  const len = res.headers.get("content-length");
  return {
    contentLength: len ? Number(len) : undefined,
    lastModified: res.headers.get("last-modified") || undefined,
  };
}

async function downloadAndUpload(link) {
  const dir = await mkdtemp(join(tmpdir(), "mirror-"));
  const filePath = join(dir, link.assetName); // gh uses basename as asset name
  const res = await fetch(link.sourceUrl, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${link.sourceUrl} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(filePath));
  console.log(`  ↑ uploading ${link.assetName}…`);
  gh(["release", "upload", RELEASE_TAG, filePath, "--clobber", "--repo", MIRROR_REPO], { stdio: "inherit" });
}

// --- main -------------------------------------------------------------------
const indexRes = await fetch(SOURCE_INDEX_URL, { redirect: "follow" });
if (!indexRes.ok) fail(`Could not fetch index: ${indexRes.status}`);
const links = parseDownloadsHtml(await indexRes.text());
if (links.length === 0) fail("Parsed 0 links — refusing to sync (source may be down/changed).");
console.log(`Found ${links.length} source links.`);

ensureRelease();

let manifest = {};
try {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
} catch {
  /* first run — empty manifest */
}

const items = [];
let changedCount = 0;

for (const link of links) {
  const prev = manifest[link.sourceUrl];
  try {
    const head = await headSource(link.sourceUrl);
    const changed =
      !prev ||
      !prev.url ||
      prev.contentLength !== head.contentLength ||
      prev.lastModified !== head.lastModified;

    if (changed) {
      console.log(`• ${link.assetName} — changed, mirroring`);
      await downloadAndUpload(link);
      changedCount++;
    } else {
      console.log(`• ${link.assetName} — unchanged`);
    }

    manifest[link.sourceUrl] = {
      contentLength: head.contentLength,
      lastModified: head.lastModified,
      assetName: link.assetName,
      url: assetUrl(link.assetName),
    };
    items.push({ ...link, url: assetUrl(link.assetName), ...head });
  } catch (err) {
    console.error(`  ! ${link.assetName}: ${err.message}`);
    if (prev?.url) {
      // Keep the last-good mirror live rather than dropping the link.
      items.push({
        ...link,
        url: prev.url,
        contentLength: prev.contentLength,
        lastModified: prev.lastModified,
      });
    }
  }
}

await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Mirrored ${changedCount} changed file(s); ${items.length} link(s) ready.`);

// Push to Convex.
if (!CONVEX_SITE_URL || !SYNC_SECRET) fail("CONVEX_SITE_URL / DOWNLOADS_SYNC_SECRET not set.");
const payload = items.map((i) => ({
  sourceUrl: i.sourceUrl,
  url: i.url,
  label: i.label,
  labelAr: i.labelAr,
  category: i.category,
  sortOrder: i.sortOrder,
  contentLength: i.contentLength,
  lastModified: i.lastModified,
}));

const post = await fetch(`${CONVEX_SITE_URL}/sync/downloads`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${SYNC_SECRET}` },
  body: JSON.stringify({ items: payload }),
});
if (!post.ok) fail(`Convex sync failed: ${post.status} ${await post.text()}`);
console.log(`✓ Convex updated: ${await post.text()}`);
