import { Octokit } from "@octokit/rest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { jsonrepair } from "jsonrepair";

// --- Configuration ---
const CONFIG = {
  MODEL_NAME: "gemini-2.5-flash",
  MAX_LINES_PER_FILE: 400,
  CONTEXT_PADDING: 2,
  MODULE_REGEX: /^[0-9]{2}-[\w-]+$/,
  MODULE_SECTION_PATTERN: /##\s+([0-9]{2}-[\w-]+)[\s\S]*?(?=\n##\s+[0-9]{2}-|$)/g,
};

// --- Utils ---
class Utils {
  static cleanModelJson(raw) {
    if (!raw) return "";
    // Remove markdown code fences
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const content = fenced ? fenced[1].trim() : raw.trim();
    
    // Extract JSON object if surrounded by text
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }
    return content;
  }

  static safeParseJson(raw) {
    const cleaned = Utils.cleanModelJson(raw);
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      try {
        // Attempt to repair broken JSON from LLM
        return JSON.parse(jsonrepair(cleaned));
      } catch (err2) {
        throw new Error(`Failed to parse AI response: ${err2.message}`);
      }
    }
  }

  /**
   * Converts the AI response into a Markdown string if structured parsing fails.
   */
  static formatFallbackMarkdown(conclusion, general, comments) {
    const lines = [`**Review Result:** ${conclusion}`];
    if (general) lines.push(`\n**Overview:** ${general}`);
    if (comments.length) {
      lines.push("\n**Inline Comments:**");
      comments.forEach(c => lines.push(`- ${c.filepath}:${c.start_line} ${c.comment}`));
    }
    return lines.join("\n");
  }
}

// --- Diff & File Processing ---
class FileManager {
  static parsePatchLineNumbers(patch) {
    if (!patch) return new Set();
    const lines = patch.split("\n");
    const included = new Set();
    let newLine = 0;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
        if (match) newLine = Number(match[1]);
        continue;
      }
      if (line.startsWith("+") || line.startsWith(" ")) {
        included.add(newLine);
        newLine++;
      }
    }
    return included;
  }

  static async buildSnippets(octokit, owner, repo, ref, changedFiles, contentsMap) {
    const snippets = [];
    
    for (const file of changedFiles) {
      if (!file.patch || file.status === "removed") continue;

      const validLines = FileManager.parsePatchLineNumbers(file.patch);
      if (validLines.size === 0) continue;

      // Get full content to provide context
      let lines = contentsMap.get(file.filename);
      if (!lines) {
        // Fallback fetch if not in map
        const raw = await GitHubService.fetchFileContent(octokit, owner, repo, ref, file.filename);
        lines = raw.split("\n");
      }

      // Add context padding
      const linesWithContext = new Set();
      for (const line of validLines) {
        for (let i = -CONFIG.CONTEXT_PADDING; i <= CONFIG.CONTEXT_PADDING; i++) {
          const candidate = line + i;
          if (candidate >= 1 && candidate <= lines.length) linesWithContext.add(candidate);
        }
      }

      const sortedLines = Array.from(linesWithContext)
        .sort((a, b) => a - b)
        .slice(0, CONFIG.MAX_LINES_PER_FILE);

      const codeBlock = sortedLines
        .map(num => `${num}: ${lines[num - 1] || ""}`)
        .join("\n");

      snippets.push(`File: ${file.filename}\n${codeBlock}`);
    }

    return snippets.join("\n\n") || "No parseable changes found.";
  }
}

// --- GitHub Interaction ---
class GitHubService {
  constructor(token, context) {
    this.octokit = new Octokit({ auth: token });
    this.context = context; // { owner, repo, prNumber, ref, actor }
  }

  static async fetchFileContent(octokit, owner, repo, ref, path) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (e) {
      console.warn(`Could not read ${path}: ${e.message}`);
      return "";
    }
  }

  async getChangedFiles() {
    return await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.context.owner,
      repo: this.context.repo,
      pull_number: this.context.prNumber,
      per_page: 100,
    });
  }

  async fetchAllFileContents(files) {
    const map = new Map();
    await Promise.all(
      files.map(async (file) => {
        if (file.status === "removed") return;
        const content = await GitHubService.fetchFileContent(
          this.octokit, 
          this.context.owner, 
          this.context.repo, 
          this.context.ref, 
          file.filename
        );
        map.set(file.filename, content.split("\n"));
      })
    );
    return map;
  }

  /**
   * Post the structured review (General comment + Status + Inline comments)
   */
  async submitReview(reviewData, fileContents, changedFiles) {
    const { conclusion, general_comment, comments } = reviewData;
    
    // 1. Determine Event Type
    let event = conclusion === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "APPROVE";
    const isSelfReview = this.context.actor === this.context.prAuthor;
    
    // You cannot request changes on your own PR
    if (isSelfReview) event = "COMMENT"; 

    // 2. Normalize Comments for GitHub API
    const ghComments = this._normalizeComments(comments, fileContents, changedFiles);

    // 3. Fallback logic: If no general comment and no inline comments, do nothing
    if (!general_comment && ghComments.length === 0) {
      console.log("Empty review generated. Skipping.");
      return;
    }

    console.log(`Submitting review: ${event} with ${ghComments.length} inline comments.`);

    try {
      await this.octokit.pulls.createReview({
        owner: this.context.owner,
        repo: this.context.repo,
        pull_number: this.context.prNumber,
        body: general_comment || "Automated Review (No summary provided)",
        event: event,
        comments: ghComments,
      });
      console.log("Review successfully created.");
    } catch (err) {
      console.error("Failed to create structured review. Falling back to plain comment.", err.message);
      // Fallback: Post as a single issue comment if the detailed review fails 
      // (often due to invalid line numbers in inline comments)
      const fallbackBody = Utils.formatFallbackMarkdown(conclusion, general_comment, comments);
      await this.octokit.issues.createComment({
        owner: this.context.owner,
        repo: this.context.repo,
        issue_number: this.context.prNumber,
        body: fallbackBody
      });
    }
  }

  _normalizeComments(rawComments, fileContents, changedFiles) {
    const validPaths = new Set(changedFiles.map(f => f.filename));
    const results = [];

    for (const c of rawComments) {
      if (!c.filepath || !validPaths.has(c.filepath)) continue;

      const lines = fileContents.get(c.filepath);
      const start = Number(c.start_line);
      
      // Validation: Line must exist
      if (!Number.isInteger(start) || start < 1) continue;
      if (lines && start > lines.length) continue;

      const commentObj = {
        path: c.filepath,
        body: c.comment,
        side: "RIGHT",
        line: start // GitHub API uses 'line' for the end of the comment
      };

      // Handle multiline
      if (c.end_line && Number(c.end_line) > start) {
        const end = Math.min(Number(c.end_line), lines ? lines.length : Number(c.end_line));
        commentObj.start_line = start;
        commentObj.line = end;
        commentObj.start_side = "RIGHT";
      }

      results.push(commentObj);
    }
    return results;
  }
}

// --- Instructions & Prompting ---
class PromptService {
  static async loadContext(octokit, context, changedFiles) {
    // 1. Detect Modules
    const modules = new Set();
    changedFiles.forEach(f => {
      const root = f.filename.split("/")[0];
      if (CONFIG.MODULE_REGEX.test(root)) modules.add(root);
    });
    const moduleList = [...modules];

    // 2. Detect Tasks
    const tasks = new Set();
    changedFiles.forEach(f => {
      const [mod, task] = f.filename.split("/");
      if (CONFIG.MODULE_REGEX.test(mod) && task) tasks.add(`${mod}/${task}`);
    });

    if (moduleList.length === 0) return null; // Nothing to review

    // 3. Load Readmes (Tasks)
    const taskPrompts = [];
    for (const t of tasks) {
      const readmePath = `${t}/README.md`;
      const content = await GitHubService.fetchFileContent(octokit, context.owner, context.repo, context.ref, readmePath);
      if (content) taskPrompts.push(`### Task: ${t}\n${content}`);
    }

    // 4. Load Module Instructions (Local file)
    let moduleInstructions = "";
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const instructionsPath = path.resolve(currentDir, "../instructions/modules.md");
      const fileContent = await fs.readFile(instructionsPath, "utf8");
      
      const sections = {};
      let match;
      while ((match = CONFIG.MODULE_SECTION_PATTERN.exec(fileContent)) !== null) {
        sections[match[1]] = match[0].trim();
      }
      
      moduleInstructions = moduleList.map(id => sections[id] || "").join("\n\n");
    } catch (e) {
      console.warn("Could not load local module instructions:", e.message);
    }

    return { moduleInstructions, taskInstructions: taskPrompts.join("\n\n") };
  }

  static generate(moduleCtx, taskCtx, snippets) {
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
${moduleCtx}

Упоминай, если встречается решение, выходящее за рамки этих модулей.

#### Описание задач (README)
${taskCtx}

#### Changed files (with line numbers)
${snippets}

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
}

// --- Main Workflow ---
async function main() {
  // 1. Environment Setup
  const token = process.env.GITHUB_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!token || !geminiKey) throw new Error("Missing secrets (GITHUB_TOKEN or GEMINI_API_KEY)");

  // 2. Event Payload Parsing
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr) throw new Error("Not a pull_request event");

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const context = {
    owner,
    repo,
    prNumber: pr.number,
    ref: pr.head.sha,
    actor: process.env.GITHUB_ACTOR,
    prAuthor: pr.user.login
  };

  const gh = new GitHubService(token, context);

  // 3. Data Gathering
  console.log(`Starting review for PR #${pr.number}`);
  const changedFiles = await gh.getChangedFiles();
  
  // 4. Context Loading
  const ctxData = await PromptService.loadContext(gh.octokit, context, changedFiles);
  if (!ctxData) {
    console.log("No relevant coursework files detected. Skipping.");
    return;
  }

  const fileContents = await gh.fetchAllFileContents(changedFiles);
  const snippets = await FileManager.buildSnippets(gh.octokit, owner, repo, context.ref, changedFiles, fileContents);

  // 5. AI Execution
  const prompt = PromptService.generate(ctxData.moduleInstructions, ctxData.taskInstructions, snippets);
  
  console.log("Sending prompt to Gemini...");
  const genAI = new GoogleGenerativeAI(geminiKey);
  const model = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });
  
  const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  // 6. Response Parsing & Submission
  const reviewData = Utils.safeParseJson(responseText);
  await gh.submitReview(reviewData, fileContents, changedFiles);
}

main().catch(err => {
  console.error("Workflow Failed:", err);
  process.exit(1);
});