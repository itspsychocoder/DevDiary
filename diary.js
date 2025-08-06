import dotenv from 'dotenv';
dotenv.config();
import { Octokit } from 'octokit';
import { subDays, endOfDay, formatISO, format } from 'date-fns';
import { GoogleGenAI } from '@google/genai';

const octokit = new Octokit({ auth: process.env.TOKEN_GITHUB });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_ID = 'gemini-2.5-flash';
const RATE_LIMIT_MS = 300;
const author = "itspsychocoder";

const mode = process.argv.includes('--polished') ? 'polished' : 'raw';

if (!process.env.TOKEN_GITHUB || !process.env.GEMINI_API_KEY || !author) {
  console.error('Missing TOKEN_GITHUB, GITHUB_AUTHOR, or GEMINI_API_KEY');
  process.exit(1);
}

async function listRecentRepos() {
  const cutoff = subDays(new Date(), 30);
  const repos = await octokit.paginate(
    octokit.rest.repos.listForAuthenticatedUser,
    { visibility: 'all', sort: 'pushed', direction: 'desc', per_page: 100 }
  );
  return repos.filter(r => new Date(r.pushed_at) >= cutoff)
              .map(r => ({ owner: r.owner.login, repo: r.name }));
}

async function fetchCommits(repo) {
  const since = formatISO(subDays(new Date(),7), { representation: 'complete' });
  const until = formatISO(endOfDay(new Date()), { representation: 'complete' });
  try {
    const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
      owner: repo.owner, repo: repo.repo, author, since, until, per_page: 100
    });
    return commits.map(c => ({
      date: c.commit.author.date,
      repo: repo.repo,
      message: c.commit.message.split('\n')[0]
    }));
  } catch {
    return [];
  }
}

async function rewriteWithGemini(raw) {
  const res = await ai.models.generateContent({
    model: MODEL_ID,
    contents: [{ role: 'user', parts: [{ text: `Summarize into a professional weekly update:\n\n${raw}` }] }]
  });
  return res.response?.text() || raw;
}

(async () => {
  const repos = await listRecentRepos();
  const commits = [];
  for (const [i, r] of repos.entries()) {
    const cs = await fetchCommits(r);
    commits.push(...cs);
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  if (!commits.length) {
    console.log('No commits this week');
    process.exit(0);
  }

  const grouped = commits.reduce((map, c) => {
    const day = format(new Date(c.date), 'yyyy-MM-dd');
    (map[day] = map[day] || []).push(`• [${c.repo}] ${c.message}`);
    return map;
  }, {});

  const rawLines = [`## Weekly Git Activity (${format(subDays(new Date(),7), 'MMM d')} – ${format(new Date(), 'MMM d')})`];
  for (const day of Object.keys(grouped).sort()) {
    rawLines.push(`\n*${day}*`);
    rawLines.push(...grouped[day]);
  }
  const raw = rawLines.join('\n');

  console.log(`raw<<EOF\n${raw}\nEOF`);

  if (mode === 'polished') {
    const polished = await rewriteWithGemini(raw);
    console.log(`polished<<EOF\n${polished}\nEOF`);
  }

  // Prepare blocks for each day
  Object.entries(grouped).forEach(([day, entries], idx) => {
    const blockText = `*${day}*\n${entries.join('\n')}`;
    const truncated = blockText.length > 2800 ? blockText.slice(0,2795) + '\n…' : blockText;
    console.log(`block_${idx}<<EOF\n${truncated}\nEOF`);
  });
  console.log(`TOTAL_BLOCKS=${Object.keys(grouped).length}`);
})();
