import { Octokit } from "@octokit/rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { jsonrepair } from "jsonrepair";

const MODULE_SECTION_PATTERN = /##\s+([0-9]{2}-[\w-]+)[\s\S]*?(?=\n##\s+[0-9]{2}-|$)/g;
const CONTEXT_PADDING = 2; // lines of context around changed lines
const MAX_LINES_PER_FILE = 400; // safety cap to avoid huge prompts

async function getEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set; cannot read event payload");
  }
  const raw = await fs.readFile(eventPath, "utf8");
  return JSON.parse(raw);
}

async function getChangedFiles(octokit, owner, repo, pull_number) {
  return await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
}

function detectModules(changedFiles) {
  const modules = new Set();
  changedFiles.forEach(({ filename }) => {
    const [maybeModule] = filename.split("/");
    if (/^[0-9]{2}-[\w-]+$/.test(maybeModule)) {
      modules.add(maybeModule);
    }
  });
  return [...modules];
}

function detectTasks(changedFiles) {
  const tasks = new Set();
  changedFiles.forEach(({ filename }) => {
    const [module, task] = filename.split("/");
    if (module && task && /^[0-9]{2}-[\w-]+$/.test(module)) {
      tasks.add(`${module}/${task}`);
    }
  });
  return [...tasks];
}

async function loadModuleSections() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const modulesPath = path.resolve(currentDir, "../instructions/modules.md");
  const content = await fs.readFile(modulesPath, "utf8");
  const sections = {};
  let match;
  while ((match = MODULE_SECTION_PATTERN.exec(content)) !== null) {
    const [, moduleId] = match;
    sections[moduleId] = match[0].trim();
  }
  return sections;
}

function parsePatchLineNumbers(patch) {
  if (!patch) return new Set();
  const lines = patch.split("\n");
  const included = new Set();
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const headerMatch = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (headerMatch) {
        newLine = Number(headerMatch[1]);
      }
      continue;
    }

    if (line.startsWith("+") || line.startsWith(" ")) {
      included.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // deletion: advance only old counter, not new
      continue;
    }
  }

  return included;
}

function addContextLines(lineNumbers, totalLines) {
  const withContext = new Set();
  for (const line of lineNumbers) {
    for (let delta = -CONTEXT_PADDING; delta <= CONTEXT_PADDING; delta += 1) {
      const candidate = line + delta;
      if (candidate >= 1 && candidate <= totalLines) {
        withContext.add(candidate);
      }
    }
  }
  return withContext;
}

async function fetchFileContent(octokit, owner, repo, ref, filePath) {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref,
  });

  if (!("content" in data)) {
    throw new Error(`Unable to read content for ${filePath}`);
  }

  const buff = Buffer.from(data.content, "base64");
  return buff.toString("utf8");
}

async function fetchChangedFileContents(octokit, owner, repo, ref, changedFiles) {
  const map = new Map();

  for (const file of changedFiles) {
    if (file.status === "removed") continue;
    const content = await fetchFileContent(octokit, owner, repo, ref, file.filename);
    map.set(file.filename, content.split("\n"));
  }

  return map;
}

async function buildFileSnippets(octokit, owner, repo, ref, changedFiles, contentsMap) {
  const snippets = [];

  for (const file of changedFiles) {
    if (!file.patch) continue;

    const lineNumbers = parsePatchLineNumbers(file.patch);
    if (lineNumbers.size === 0) continue;

    const lines = contentsMap.get(file.filename)
      || (await fetchFileContent(octokit, owner, repo, ref, file.filename)).split("\n");
    const lineNumbersWithContext = addContextLines(lineNumbers, lines.length);
    const sortedLines = Array.from(lineNumbersWithContext).sort((a, b) => a - b).slice(0, MAX_LINES_PER_FILE);

    const formatted = sortedLines
      .map((num) => `${num}: ${lines[num - 1] ?? ""}`)
      .join("\n");

    snippets.push(`File: ${file.filename}\n${formatted}`);
  }

  if (snippets.length === 0) {
    const fileList = changedFiles.map((f) => f.filename).join(", ");
    return `Patch data недоступна, изменённые файлы: ${fileList}`;
  }

  return snippets.join("\n\n");
}

function buildModuleContext(modulesInScope, moduleSections) {
  return modulesInScope
    .map((id) => moduleSections[id] || `## ${id}\n(нет конспекта; ориентируйся только на материалы этого модуля)`)
    .join("\n\n");
}

async function loadTaskReadmes(octokit, owner, repo, ref, tasks) {
  const blocks = [];

  for (const task of tasks) {
    const [module, taskName] = task.split("/");
    const readmePath = `${module}/${taskName}/README.md`;

    try {
      const content = await fetchFileContent(octokit, owner, repo, ref, readmePath);
      blocks.push(`### ${module}/${taskName}\n${content}`);
    } catch (err) {
      blocks.push(`### ${module}/${taskName}\nНе удалось загрузить README (${readmePath})`);
    }
  }

  return blocks.join("\n\n");
}

function buildPrompt(moduleContext, tasksContext, fileSnippets) {
  return `### Student GitHub PR Code Review

#### Role
You are an experienced developer and mentor who reviews Javascript/DOM/CSS assignments submitted by students. Your feedback style should be personal and informal, as though you're reviewing the student's code directly, offering genuine and helpful advice. Keep your comments concise and straightforward, avoiding overly complex language.
**You must write all comments and feedback in Russian language. This is a strict requirement.**

It's important to express your personal opinions clearly, using phrases like "Я рекомендую", "Мне кажется", or "Было бы лучше" while explaining why these approaches are preferable. Your goal is not just to point out mistakes, but to help students understand why certain practices are considered good or bad. Avoid generic praise like "Продолжай в том же духе!" as it sounds unnatural.

#### Important Context
- The code is written in Javascript/CSS and has passed automated tests.
- Avoid general comments; always rely explicitly on the task requirements (which is provided as part of the message).
- Do not comment on missing types or async/await issues since functionality is assured by tests.
- Focus strictly on logic, algorithms, best practices, and overall code quality.
- **Do not suggest new features or capabilities outside the current task and implementation.**
- **Only review what has already been implemented.**
- Do not suggest adding new libraries or integrating with external services—all necessary dependencies are already present.

#### Review Criteria
Evaluate the submission based on:
1. **Task Completion**
   - Has the task been fully implemented?
   - Are there any missing requirements?
2. **Code Quality**
   - Is the code readable and easy to understand?
   - Are JavaScript/Node.js best practices followed?
   - Are variables, functions, and classes named clearly and meaningfully?
   - Is the code properly formatted and styled consistently?
3. **Algorithm & Logic**
   - Is the implementation efficient?
   - Could the same outcome be achieved more simply?
   - Are the chosen data structures appropriate?
4. **Error Handling**
   - Does the code account for edge cases and potential errors?
   - Is input validation performed correctly?
   - Are errors correctly handled and propagated?
5. **Testing** (if tests are provided)
   - Are the tests comprehensive enough?
   - Do they cover edge cases and main functionalities?

#### Guidelines for Comments
- Be concise with your messages - 1-2 sentences are usually enough.
- On this step all automated tests are already passed - you can assume everything is working according the hard requirments.
- Write specific and clear comments, precisely identifying the line of code.
- Balance constructive criticism with positive reinforcement.
- Always explain why something could be improved or done differently.
- **Do not suggest implementing new features or functionalities that are not part of the task.**
- **Do not suggest new libraries or external services; all necessary dependencies are already included.**
- **Always consider the task description carefully, paying close attention to its conditions and their fulfillment.**
- **Do not make positive comments on basic functionality that was required by the task definition.**
- **Do make positive comments on additional functionality that was implemented by the student.**
- If providing code examples, ensure they are genuinely helpful:
  - To correct real logical or functional errors.
  - To demonstrate significantly simpler or clearer solutions.
- For minor stylistic issues, explain briefly without code examples.
- Consider the student's knowledge level—comments should be clear and useful.
- Be respectful, personal, and sincere.
- Keep comments concise, ideally within one sentence. Only if deeper explanations are necessary, expand your explanation up to 5 sentences.
- Do not comment file formatting (esp. empty lines or other cosmetics).

#### Multiline Comments Support
You can in certain cases comment on multiple lines of code at once by specifying a range:
- For a single-line comment, use start_line only (or set start_line and end_line to the same value)
- For a multiline comment, set different values for start_line and end_line to comment on a range of lines
- When referencing code in a multiline comment, be specific about which parts of the code block you're discussing

Prefer one-line comments over multiline comments.

#### Module scope
Используй только материалы текущего модуля. Контекст модулей:
${moduleContext}

Упоминай, если встречается решение, выходящее за рамки этих модулей.

#### Описание задач (README)
${tasksContext}

#### Changed files (with line numbers)
${fileSnippets}

#### Response Format
Your response must strictly follow this JSON structure:
{
  "conclusion": "APPROVE" or "REQUEST_CHANGES",
  "general_comment": "Overall impression and brief evaluation of the work (in Russian)",
  "comments": [
    {
      "filepath": "path/to/file.js",
      "start_line": 10,
      "end_line": 15, // Optional: omit for single-line comments
      "comment": "Your specific comment about this code section (in Russian)"
    }
  ]
}

Each comment:
- Precisely identify the line number or range of lines.
- Express your personal opinion clearly and explain your reasoning.
- Stay within the scope of the existing implementation.
- When providing code examples, use fully prepared and correct solutions only.

Conclusion ("conclusion"):
- "APPROVE" if everything is satisfactory.
- "REQUEST_CHANGES" if there are critical issues to address.

Remember, your comments are educational tools meant to help students better understand the principles of quality code.

Respond with JSON only.`;
}

async function callGemini(prompt, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function postComment(octokit, owner, repo, issue_number, body) {
  await octokit.issues.createComment({ owner, repo, issue_number, body });
}

function formatMarkdownReview(rawJson) {
  try {
    const parsed = safeParseModelJson(rawJson);
    const conclusion = parsed.conclusion || "APPROVE";
    const general = parsed.general_comment || "";
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];

    const lines = [];
    lines.push(`**Итог:** ${conclusion}`);
    if (general) {
      lines.push(`**Общее впечатление:** ${general}`);
    }

    if (comments.length > 0) {
      lines.push("");
      lines.push("**Замечания:**");
      comments.forEach((c) => {
        const file = c.filepath || "не указан файл";
        const start = c.start_line ?? "?";
        const end = c.end_line && c.end_line !== c.start_line ? `-${c.end_line}` : "";
        const text = c.comment || "";
        lines.push(`- ${file}:${start}${end} — ${text}`);
      });
    }

    return lines.join("\n");
  } catch (err) {
    return rawJson;
  }
}

function parseModelResponse(rawJson) {
  const parsed = safeParseModelJson(rawJson);
  const conclusion = parsed.conclusion === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "APPROVE";
  const general = typeof parsed.general_comment === "string" ? parsed.general_comment : "";
  const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
  return { conclusion, general, comments };
}

function cleanModelJson(raw) {
  if (!raw) throw new Error("Empty model response");

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}

function safeParseModelJson(raw) {
  const cleaned = cleanModelJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    try {
      const repaired = jsonrepair(cleaned);
      return JSON.parse(repaired);
    } catch (err2) {
      throw err2;
    }
  }
}

function normalizeReviewComments(modelComments, fileContents, changedFiles) {
  const changedSet = new Set(changedFiles.map((f) => f.filename));
  const results = [];

  for (const c of modelComments) {
    if (!c || !c.filepath || !changedSet.has(c.filepath)) continue;
    const lines = fileContents.get(c.filepath);
    if (!lines) continue;

    const start = Number(c.start_line);
    const end = c.end_line !== undefined ? Number(c.end_line) : start;
    if (!Number.isInteger(start) || start < 1) continue;
    const safeEnd = Number.isInteger(end) && end >= start ? end : start;
    const maxLine = lines.length;
    if (start > maxLine) continue;

    const commentObj = {
      path: c.filepath,
      body: c.comment || "",
      side: "RIGHT",
      line: Math.min(safeEnd, maxLine),
    };

    if (safeEnd !== start && safeEnd <= maxLine) {
      commentObj.start_line = start;
      commentObj.start_side = "RIGHT";
    }

    results.push(commentObj);
  }

  return results;
}

async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("GITHUB_TOKEN is required");

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiKey) throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required");

  const payload = await getEventPayload();
  const pr = payload.pull_request;
  if (!pr) throw new Error("This workflow only supports pull_request events");
  const prAuthor = pr.user?.login;
  const actor = process.env.GITHUB_ACTOR;

  const repoString = process.env.GITHUB_REPOSITORY;
  if (!repoString || !repoString.includes("/")) throw new Error("GITHUB_REPOSITORY is not set");
  const [owner, repo] = repoString.split("/");

  const octokit = new Octokit({ auth: githubToken });

  const changedFiles = await getChangedFiles(octokit, owner, repo, pr.number);
  const modulesInScope = detectModules(changedFiles);
  const tasksInScope = detectTasks(changedFiles);

  if (modulesInScope.length === 0) {
    console.log("No coursework modules detected in changed files; skipping AI review.");
    return;
  }

  const moduleSections = await loadModuleSections();
  const moduleContext = buildModuleContext(modulesInScope, moduleSections);
  const fileContents = await fetchChangedFileContents(octokit, owner, repo, pr.head.sha, changedFiles);
  const fileSnippets = await buildFileSnippets(octokit, owner, repo, pr.head.sha, changedFiles, fileContents);
  const tasksContext = tasksInScope.length
    ? await loadTaskReadmes(octokit, owner, repo, pr.head.sha, tasksInScope)
    : "Задачи не определены по изменённым файлам.";

  const prompt = buildPrompt(moduleContext, tasksContext, fileSnippets);

  console.log(`Modules detected: ${modulesInScope.join(", ")}`);

  const reviewJson = await callGemini(prompt, geminiKey);
  if (!reviewJson || reviewJson.trim().length === 0) {
    await postComment(octokit, owner, repo, pr.number, "Gemini did not return a review. Please rerun the workflow.");
    console.log("Posted fallback review comment");
    return;
  }

  try {
    const parsed = parseModelResponse(reviewJson);
    const reviewComments = normalizeReviewComments(parsed.comments, fileContents, changedFiles);
    const event = parsed.conclusion === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "APPROVE";
    const selfReview = actor && prAuthor && actor === prAuthor;
    const finalEvent = selfReview ? "COMMENT" : event;

    if (!parsed.general && reviewComments.length === 0) {
      console.log("No general comment or inline comments to post.");
      return;
    }

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pr.number,
      body: parsed.general,
      event: finalEvent,
      comments: reviewComments,
    });

    console.log(`Posted PR review with event: ${finalEvent}${selfReview ? " (self-review fallback)" : ""}`);
  } catch (err) {
    console.warn("Failed to parse structured review, posting raw markdown. Error:", err.message);
    const formatted = formatMarkdownReview(reviewJson);
    await postComment(octokit, owner, repo, pr.number, formatted);
    console.log("Posted fallback markdown comment");
  }
}

main().catch((error) => {
  console.error("Reviewer failed", error);
  process.exit(1);
});
