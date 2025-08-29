import dotenv from "dotenv";
dotenv.config();

import { Octokit } from "octokit";
import { subDays, endOfDay, formatISO, format } from "date-fns";
import { GoogleGenAI } from "@google/genai";

const octokit = new Octokit({ auth: process.env.TOKEN_GITHUB });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL_ID = "gemini-2.5-flash";
const RATE_LIMIT_MS = 300;
const CHUNK_SIZE = 2900; // Slack message safe limit

const mode = process.argv.includes("--polished") ? "polished" : "raw";
const author = "itspsychocoder";

if (!process.env.TOKEN_GITHUB || !process.env.GEMINI_API_KEY || !author) {
  console.error("Missing TOKEN_GITHUB or GEMINI_API_KEY or author");
  process.exit(1);
}

async function listRecentRepos() {
  const cutoff = subDays(new Date(), 30);
  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    { visibility: "all", sort: "pushed", direction: "desc", per_page: 100 }
  );
  return repos
    .filter((r) => new Date(r.pushed_at) >= cutoff)
    .map((r) => ({ owner: r.owner.login, repo: r.name }));
}

async function fetchCommits(repo) {
  const since = formatISO(subDays(new Date(), 7));
  const until = formatISO(endOfDay(new Date()));
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

function splitIntoChunks(text, maxSize = CHUNK_SIZE) {
  const parts = [];
  let chunk = "";

  for (const line of text.split("\n")) {
    if ((chunk + "\n" + line).length > maxSize) {
      parts.push(chunk.trim());
      chunk = line;
    } else {
      chunk += "\n" + line;
    }
  }
  if (chunk) parts.push(chunk.trim());
  return parts;
}

async function rewriteWithGemini(raw) {
  const chunks = splitIntoChunks(raw);
  const polishedChunks = [];

  for (const chunk of chunks) {
    const resp = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: "user",
          parts: [{ text: `I will give you my GitHub commits for the week in the format:

### YYYY-MM-DD
- {repo name} commit message
- {repo name} commit message

Your task:  
1. Read all commits carefully.  
2. Summarize what I accomplished each day in simple language (not just restating commit messages).  
3. Group related commits together into meaningful activities.  
4. Keep the summaries concise but informative (2–5 bullet points per day).  
5. Highlight any patterns across days if relevant (e.g., if I worked on a feature for multiple days).  

Now here are the commits::\n\n${chunk}` }],
        },
      ],
    });
    polishedChunks.push(resp.response?.text() ?? chunk);
    await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
  }

  return polishedChunks;
}

(async () => {
  const repos = await listRecentRepos();

  const commitList = [];
  for (const r of repos) {
    const cs = await fetchCommits(r);
    if (cs.length) commitList.push(...cs);
    await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
  }

  if (!commitList.length) {
    console.log("No commits in the last week.");
    return;
  }

  const grouped = commitList.reduce((map, c) => {
    const day = format(new Date(c.date), "yyyy-MM-dd");
    (map[day] = map[day] || []).push(`- [${c.repo}] ${c.message}`);
    return map;
  }, {});

  let rawMd = `## Weekly Git Activity (${format(
    subDays(new Date(), 7),
    "MMM d"
  )} – ${format(new Date(), "MMM d")})\n`;
  for (const [day, entries] of Object.entries(grouped)) {
    rawMd += `\n### ${day}\n${entries.join("\n")}\n`;
  }

  if (mode === "raw") {
    const rawChunks = splitIntoChunks(rawMd);
    for (const chunk of rawChunks) {
      console.log("<<CHUNK>>");
      console.log(chunk);
    }
  } else {
    const polishedChunks = await rewriteWithGemini(rawMd);
    for (const chunk of polishedChunks) {
      console.log("<<CHUNK>>");
      console.log(chunk);
    }
  }
})();
