const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DB_DIR, "prompts-db.json");
const INDEX_PATH = path.join(ROOT, "index.html");

let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function createDefaultDb() {
  const now = nowIso();
  return {
    categories: [
      { id: "cat-content", name: "内容创作", parent_id: null, created_at: now },
      { id: "cat-social", name: "社媒文案", parent_id: "cat-content", created_at: now },
      { id: "cat-video", name: "视频脚本", parent_id: "cat-content", created_at: now },
      { id: "cat-growth", name: "营销增长", parent_id: null, created_at: now },
      { id: "cat-product", name: "产品与设计", parent_id: null, created_at: now },
      { id: "cat-dev", name: "工程研发", parent_id: null, created_at: now }
    ],
    prompts: [
      {
        id: "p-1",
        title: "爆款短视频脚本",
        category_id: "cat-video",
        tags: ["脚本", "短视频", "开场"],
        content:
          "你是一位短视频编导。主题是【主题】。请按以下结构输出：1）3种抓眼开场；2）45秒脚本分镜；3）镜头节奏建议；4）结尾行动引导。语气真实有张力。",
        images: [],
        marks: [],
        created_at: now,
        updated_at: now
      },
      {
        id: "p-2",
        title: "代码重构建议",
        category_id: "cat-dev",
        tags: ["重构", "代码审查"],
        content:
          "请审查以下代码并给出重构建议：1）可读性问题；2）潜在 bug；3）性能优化点；4）可测试性改进；5）重构后示例代码。若信息不足，先提出3个澄清问题。",
        images: [],
        marks: [],
        created_at: now,
        updated_at: now
      }
    ]
  };
}

function sanitizeImageData(imageData) {
  if (typeof imageData !== "string") return "";
  const trimmed = imageData.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("data:image/")) return "";
  return trimmed;
}

function normalizeImages(images, legacyImageData, legacyImageName) {
  const list = [];

  if (Array.isArray(images)) {
    images.forEach((item) => {
      if (!item) return;
      if (typeof item === "string") {
        const data = sanitizeImageData(item);
        if (data) {
          list.push({ id: randomUUID(), name: "image", data });
        }
        return;
      }
      const data = sanitizeImageData(item.data || item.imageData || item.src || "");
      if (!data) return;
      list.push({
        id: String(item.id || randomUUID()),
        name: String(item.name || item.imageName || "image"),
        data
      });
    });
  } else {
    const data = sanitizeImageData(legacyImageData);
    if (data) {
      list.push({
        id: randomUUID(),
        name: typeof legacyImageName === "string" && legacyImageName.trim() ? legacyImageName.trim() : "image",
        data
      });
    }
  }

  return list;
}


function normalizeDb(raw) {
  const base = createDefaultDb();
  const categoriesRaw = Array.isArray(raw?.categories) ? raw.categories : base.categories;
  const promptsRaw = Array.isArray(raw?.prompts) ? raw.prompts : base.prompts;

  const categories = categoriesRaw
    .filter((cat) => cat && typeof cat.name === "string")
    .map((cat) => {
      const parentId = cat.parent_id ?? cat.parentId ?? null;
      return {
        id: String(cat.id || randomUUID()),
        name: cat.name.trim(),
        parent_id: parentId ? String(parentId) : null,
        created_at: cat.created_at || cat.createdAt || nowIso()
      };
    })
    .filter((cat) => cat.name);

  const categoryIds = new Set(categories.map((cat) => cat.id));
  categories.forEach((cat) => {
    if (cat.parent_id && !categoryIds.has(cat.parent_id)) {
      cat.parent_id = null;
    }
  });

  const fallbackCategoryId = categories[0]?.id || "";

  const prompts = promptsRaw
    .filter((prompt) => prompt && typeof prompt.title === "string" && typeof prompt.content === "string")
    .map((prompt) => {
      const categoryId = String(prompt.category_id || prompt.categoryId || "");
      const tags = Array.isArray(prompt.tags)
        ? prompt.tags.map((tag) => String(tag).trim()).filter(Boolean)
        : [];
      const marks = Array.isArray(prompt.marks)
        ? prompt.marks.map((mark) => String(mark).trim()).filter(Boolean)
        : [];
      const images = normalizeImages(prompt.images, prompt.imageData, prompt.imageName);
      return {
        id: String(prompt.id || randomUUID()),
        title: prompt.title.trim(),
        category_id: categoryIds.has(categoryId) ? categoryId : fallbackCategoryId,
        tags,
        content: String(prompt.content || ""),
        images,
        marks,
        created_at: prompt.created_at || prompt.createdAt || nowIso(),
        updated_at: prompt.updated_at || prompt.updatedAt || nowIso()
      };
    });

  return { categories, prompts };
}

function buildChildrenMap(categories) {
  const map = new Map();
  categories.forEach((cat) => {
    const key = cat.parent_id || "root";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(cat.id);
  });
  return map;
}

function collectDescendants(categories, rootId) {
  const map = buildChildrenMap(categories);
  const result = new Set();
  const walk = (id) => {
    result.add(id);
    (map.get(id) || []).forEach(walk);
  };
  walk(rootId);
  return result;
}

function generateDuplicateName(name, siblings) {
  const base = String(name || "未命名").trim();
  const siblingNames = new Set(siblings.map((cat) => cat.name));
  let counter = 2;
  let candidate = `${base}${counter}`;
  while (siblingNames.has(candidate)) {
    counter += 1;
    candidate = `${base}${counter}`;
  }
  return candidate;
}

async function ensureDb() {
  await fs.mkdir(DB_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, JSON.stringify(createDefaultDb(), null, 2), "utf-8");
  }
}

async function readDb() {
  await ensureDb();
  const text = await fs.readFile(DB_PATH, "utf-8");
  const parsed = JSON.parse(text);
  return normalizeDb(parsed);
}

function writeDb(db) {
  writeQueue = writeQueue.then(async () => {
    const nextDb = normalizeDb(db);
    const tmpPath = `${DB_PATH}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(nextDb, null, 2), "utf-8");
    await fs.rename(tmpPath, DB_PATH);
    return nextDb;
  });
  return writeQueue;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function notFound(res) {
  sendJson(res, 404, { error: "Not Found" });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function normalizeIncomingImages(images, legacyImageData, legacyImageName) {
  if (!Array.isArray(images)) {
    return normalizeImages([], legacyImageData, legacyImageName);
  }

  return images
    .map((img) => {
      if (!img || typeof img !== "object") return null;
      const data = sanitizeImageData(img.data || "");
      if (!data) return null;
      return {
        id: String(img.id || randomUUID()),
        name: String(img.name || "image"),
        data
      };
    })
    .filter(Boolean);
}

function sanitizeFileName(name) {
  return String(name || "promptpack").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function dataUriToBuffer(dataUri) {
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function extensionFromMime(mime) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg"
  };
  return map[mime] || "png";
}

function mimeFromExtension(ext) {
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml"
  };
  return map[ext.toLowerCase()] || "image/png";
}

function pickFileName(baseName, usedNames) {
  const sanitized = sanitizeFileName(baseName || "image");
  let fileName = sanitized;
  let counter = 1;
  while (usedNames.has(fileName)) {
    const parts = sanitized.split(".");
    if (parts.length > 1) {
      const ext = parts.pop();
      fileName = `${parts.join(".")}-${counter}.${ext}`;
    } else {
      fileName = `${sanitized}-${counter}`;
    }
    counter += 1;
  }
  usedNames.add(fileName);
  return fileName;
}

function safeJoin(rootDir, targetPath) {
  const normalized = path.normalize(targetPath).replace(/^([/\\])+/, "");
  const resolved = path.join(rootDir, normalized);
  if (!resolved.startsWith(rootDir)) {
    return null;
  }
  return resolved;
}

async function exportPromptPack(res) {
  const db = await readDb();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "promptpack-"));
  const imagesDir = path.join(tmpDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });

  try {
    const usedNames = new Set();
    const promptsExport = db.prompts.map((prompt) => {
      const images = (prompt.images || [])
        .map((image, idx) => {
          const data = dataUriToBuffer(image.data);
          if (!data) return null;
          const ext = extensionFromMime(data.mime);
          const fallbackName = `${prompt.id}-${idx + 1}.${ext}`;
          const fileName = pickFileName(image.name || fallbackName, usedNames);
          const filePath = path.join(imagesDir, fileName);
          return fs
            .writeFile(filePath, data.buffer)
            .then(() => ({ file: `images/${fileName}`, name: image.name || fileName }))
            .catch(() => null);
        })
        .filter(Boolean);

      return Promise.all(images).then((resolved) => ({ ...prompt, images: resolved.filter(Boolean) }));
    });

    const resolvedPrompts = await Promise.all(promptsExport);

    const manifest = {
      schema_version: 1,
      exported_at: nowIso(),
      prompt_count: db.prompts.length,
      category_count: db.categories.length,
      image_count: usedNames.size
    };

    await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(tmpDir, "prompts.json"), JSON.stringify(resolvedPrompts, null, 2));
    await fs.writeFile(
      path.join(tmpDir, "categories.json"),
      JSON.stringify(db.categories, null, 2)
    );

    const packName = `prompts-${Date.now()}.promptpack`;
    const packPath = path.join(tmpDir, packName);

    await execFileAsync("zip", ["-r", "-q", packPath, "manifest.json", "prompts.json", "categories.json", "images"], {
      cwd: tmpDir
    });

    const buffer = await fs.readFile(packPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename=\"${packName}\"`
    });
    res.end(buffer);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function importPromptPack(body) {
  const data = typeof body.data === "string" ? body.data.trim() : "";
  if (!data) throw new Error("导入包为空");
  const name = sanitizeFileName(body.name || "import.promptpack");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "promptpack-import-"));
  const packPath = path.join(tmpDir, name.endsWith(".promptpack") ? name : `${name}.promptpack`);
  const extractDir = path.join(tmpDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });

  try {
    await fs.writeFile(packPath, Buffer.from(data, "base64"));
    await execFileAsync("unzip", ["-q", packPath, "-d", extractDir]);

    const categoriesPath = path.join(extractDir, "categories.json");
    const promptsPath = path.join(extractDir, "prompts.json");
    const categoriesText = await fs.readFile(categoriesPath, "utf-8");
    const promptsText = await fs.readFile(promptsPath, "utf-8");

    const categories = JSON.parse(categoriesText);
    const rawPrompts = JSON.parse(promptsText);

    const prompts = rawPrompts.map((prompt) => {
      const images = (prompt.images || [])
        .map((img) => {
          const file = typeof img === "string" ? img : img.file || img.path || img.name;
          if (!file) return null;
          const safePath = safeJoin(extractDir, file);
          if (!safePath) return null;
          return fs
            .readFile(safePath)
            .then((buffer) => {
              const ext = path.extname(safePath).replace(".", "") || "png";
              const mime = mimeFromExtension(ext);
              return {
                id: randomUUID(),
                name: typeof img === "object" && img.name ? img.name : path.basename(safePath),
                data: `data:${mime};base64,${buffer.toString("base64")}`
              };
            })
            .catch(() => null);
        })
        .filter(Boolean);

      return Promise.all(images).then((resolved) => ({ ...prompt, images: resolved.filter(Boolean) }));
    });

    const resolvedPrompts = await Promise.all(prompts);
    return await writeDb({
      categories: Array.isArray(categories) ? categories : [],
      prompts: resolvedPrompts
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/db" && req.method === "GET") {
      const db = await readDb();
      return sendJson(res, 200, db);
    }

    if (requestUrl.pathname === "/api/categories" && req.method === "POST") {
      const body = await parseBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const parentId = typeof body.parent_id === "string" ? body.parent_id.trim() : "";
      const parent_id = parentId || null;

      if (!name) return badRequest(res, "分类名称不能为空");

      const db = await readDb();
      if (parent_id && !db.categories.some((cat) => cat.id === parent_id)) {
        return badRequest(res, "父级分类不存在");
      }

      if (
        db.categories.some(
          (cat) => cat.name === name && (cat.parent_id || null) === (parent_id || null)
        )
      ) {
        return badRequest(res, "分类已存在");
      }

      const nextCategory = {
        id: randomUUID(),
        name,
        parent_id,
        created_at: nowIso()
      };

      db.categories.push(nextCategory);
      const saved = await writeDb(db);
      return sendJson(res, 201, { category: nextCategory, db: saved });
    }

    if (requestUrl.pathname.startsWith("/api/categories/") && req.method === "PATCH") {
      const id = decodeURIComponent(requestUrl.pathname.split("/").pop() || "").trim();
      if (!id) return badRequest(res, "缺少文件 id");
      const body = await parseBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const parentId = body.parent_id === null ? null : String(body.parent_id || "").trim();
      const parent_id = parentId ? parentId : parentId === null ? null : undefined;

      const db = await readDb();
      const target = db.categories.find((cat) => cat.id === id);
      if (!target) return notFound(res);

      if (parent_id !== undefined) {
        if (parent_id && !db.categories.some((cat) => cat.id === parent_id)) {
          return badRequest(res, "父级文件不存在");
        }
        if (parent_id) {
          const descendants = collectDescendants(db.categories, id);
          if (descendants.has(parent_id)) {
            return badRequest(res, "不能移动到子文件中");
          }
        }
        target.parent_id = parent_id || null;
      }

      if (name) {
        const siblingParent = target.parent_id || null;
        const siblings = db.categories.filter(
          (cat) => cat.id !== id && (cat.parent_id || null) === siblingParent
        );
        if (siblings.some((cat) => cat.name === name)) {
          return badRequest(res, "同级文件已存在");
        }
        target.name = name;
      }

      const saved = await writeDb(db);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname.startsWith("/api/categories/") && req.method === "DELETE") {
      const id = decodeURIComponent(requestUrl.pathname.split("/").pop() || "").trim();
      if (!id) return badRequest(res, "缺少文件 id");
      const db = await readDb();
      const target = db.categories.find((cat) => cat.id === id);
      if (!target) return notFound(res);

      const descendants = collectDescendants(db.categories, id);
      db.categories = db.categories.filter((cat) => !descendants.has(cat.id));
      db.prompts = db.prompts.filter((prompt) => !descendants.has(prompt.category_id));

      const saved = await writeDb(db);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname.startsWith("/api/categories/") && req.method === "POST") {
      const parts = requestUrl.pathname.split("/");
      const id = decodeURIComponent(parts[parts.length - 2] || "").trim();
      const action = parts[parts.length - 1];
      if (action !== "duplicate") return notFound(res);
      if (!id) return badRequest(res, "缺少文件 id");

      const db = await readDb();
      const source = db.categories.find((cat) => cat.id === id);
      if (!source) return notFound(res);

      const now = nowIso();
      const childrenMap = buildChildrenMap(db.categories);
      const categoryMap = new Map(db.categories.map((cat) => [cat.id, cat]));
      const newCategories = [];
      const idMap = new Map();

      const cloneCategory = (sourceId, parentId, isRoot) => {
        const original = categoryMap.get(sourceId);
        if (!original) return;
        const siblings = db.categories.filter((cat) => (cat.parent_id || null) === (parentId || null));
        const name = isRoot ? generateDuplicateName(original.name, siblings) : original.name;
        const newId = randomUUID();
        idMap.set(sourceId, newId);
        newCategories.push({
          id: newId,
          name,
          parent_id: parentId || null,
          created_at: now
        });
        (childrenMap.get(sourceId) || []).forEach((childId) => cloneCategory(childId, newId, false));
      };

      cloneCategory(id, source.parent_id || null, true);

      const newPrompts = [];
      db.prompts.forEach((prompt) => {
        const newCategoryId = idMap.get(prompt.category_id);
        if (!newCategoryId) return;
        newPrompts.push({
          ...prompt,
          id: randomUUID(),
          category_id: newCategoryId,
          created_at: now,
          updated_at: now
        });
      });

      db.categories.push(...newCategories);
      db.prompts.unshift(...newPrompts);

      const saved = await writeDb(db);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname.startsWith("/api/prompts/") && req.method === "DELETE") {
      const id = decodeURIComponent(requestUrl.pathname.split("/").pop() || "").trim();
      if (!id) return badRequest(res, "缺少提示词 id");

      const db = await readDb();
      const before = db.prompts.length;
      db.prompts = db.prompts.filter((prompt) => prompt.id !== id);
      if (before === db.prompts.length) return notFound(res);

      const saved = await writeDb(db);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname === "/api/prompts" && req.method === "POST") {
      const body = await parseBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const categoryId = typeof body.category_id === "string" ? body.category_id.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const tags = Array.isArray(body.tags)
        ? body.tags.map((tag) => String(tag).trim()).filter(Boolean)
        : [];
      const marks = Array.isArray(body.marks)
        ? body.marks.map((mark) => String(mark).trim()).filter(Boolean)
        : [];
      const images = normalizeIncomingImages(body.images, body.imageData, body.imageName);

      if (!title) return badRequest(res, "标题不能为空");
      if (!content) return badRequest(res, "提示词内容不能为空");
      if (!categoryId) return badRequest(res, "请选择分类");

      const db = await readDb();
      const categoryExists = db.categories.some((cat) => cat.id === categoryId);
      if (!categoryExists) return badRequest(res, "分类不存在");

      const now = nowIso();
      const existing = db.prompts.find((prompt) => prompt.id === id);

      if (existing) {
        existing.title = title;
        existing.category_id = categoryId;
        existing.tags = tags;
        existing.content = content;
        existing.images = images;
        existing.marks = marks;
        existing.updated_at = now;
      } else {
        db.prompts.unshift({
          id: id || randomUUID(),
          title,
          category_id: categoryId,
          tags,
          content,
          images,
          marks,
          created_at: now,
          updated_at: now
        });
      }

      const saved = await writeDb(db);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname === "/api/import" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body || (!Array.isArray(body.categories) && !Array.isArray(body.prompts))) {
        return badRequest(res, "导入数据不完整");
      }

      const saved = await writeDb({
        categories: Array.isArray(body.categories) ? body.categories : [],
        prompts: Array.isArray(body.prompts) ? body.prompts : []
      });
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if (requestUrl.pathname === "/api/export" && req.method === "GET") {
      return await exportPromptPack(res);
    }

    if (requestUrl.pathname === "/api/import-pack" && req.method === "POST") {
      const body = await parseBody(req);
      const saved = await importPromptPack(body);
      return sendJson(res, 200, { ok: true, db: saved });
    }

    if ((requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") && req.method === "GET") {
      const html = await fs.readFile(INDEX_PATH, "utf-8");
      return sendText(res, 200, html, "text/html; charset=utf-8");
    }

    if (requestUrl.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, time: nowIso() });
    }

    return notFound(res);
  } catch (err) {
    sendJson(res, 500, {
      error: "Server Error",
      detail: err instanceof Error ? err.message : String(err)
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Prompt Vault server running at http://${HOST}:${PORT}`);
  console.log(`JSON DB file: ${DB_PATH}`);
});
