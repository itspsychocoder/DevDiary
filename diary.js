import dotenv from "dotenv";
dotenv.config();

import { Octokit } from "octokit";
import { subDays, endOfDay, formatISO, format } from "date-fns";
import { GoogleGenAI } from "@google/genai";

const octokit = new Octokit({ auth: process.env.TOKEN_GITHUB });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_ID = "gemini-2.5-flash";
const RATE_LIMIT_MS = 300;

const mode = process.argv.includes("--polished") ? "polished" : "raw";
const author = "itspsychocoder";
if (!process.env.TOKEN_GITHUB || !process.env.GEMINI_API_KEY || !author) {
  console.error(
    "Missing GITHUB_TOKEN, GITHUB_AUTHOR, or GEMINI_API_KEY in .env",
  );
  process.exit(1);
}

async function listRecentRepos() {
  const cutoff = subDays(new Date(), 30);
  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    { visibility: "all", sort: "pushed", direction: "desc", per_page: 100 },
  );
  return repos
    .filter((r) => new Date(r.pushed_at) >= cutoff)
    .map((r) => ({ owner: r.owner.login, repo: r.name }));
}

async function fetchCommits(repo) {
  const since = formatISO(subDays(new Date(), 7), {
    representation: "complete",
  });
  const until = formatISO(endOfDay(new Date()), { representation: "complete" });
  try {
    const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
      owner: repo.owner,
      repo: repo.repo,
      author,
      since,
      until,
      per_page: 100,
    });
    return commits.map((c) => ({
      repo: repo.repo,
      date: c.commit.author.date,
      message: c.commit.message.split("\n")[0],
    }));
  } catch {
    return [];
  }
}

async function rewriteWithGemini(raw) {
  const resp = await ai.models.generateContent({
    model: MODEL_ID,
    contents: [
      {
        role: "user",
        parts: [{ text: `Summarize professionally:\n\n${raw}` }],
      },
    ],
  });
  return resp.response?.text() ?? raw;
}

(async () => {
  console.log("Loading recent repositories...");
  const repos = await listRecentRepos();
  console.log(`Found ${repos.length} active repos`);

  const commitList = [];
  for (const [i, r] of repos.entries()) {
    console.log(`[${i + 1}/${repos.length}] ${r.repo}`);
    const cs = await fetchCommits(r);
    if (cs.length) commitList.push(...cs);
    await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
  }

  if (!commitList.length) {
    console.log("No commits in the last week");
    return;
  }

  const grouped = commitList.reduce((map, c) => {
    const day = format(new Date(c.date), "yyyy-MM-dd");
    (map[day] = map[day] || []).push(`- [${c.repo}] ${c.message}`);
    return map;
  }, {});

  let rawMd = `## Weekly Git Activity (${format(subDays(new Date(), 7), "MMM d")} – ${format(new Date(), "MMM d")})\n`;
  for (const [day, entries] of Object.entries(grouped)) {
    rawMd += `\n### ${day}\n${entries.join("\n")}\n`;
  }

  console.log("\n📄 Raw summary:\n", rawMd);

  if (mode === "polished") {
    const polished = await rewriteWithGemini(rawMd);
    console.log("\n✨ Polished summary:\n", polished);
  }
})();
