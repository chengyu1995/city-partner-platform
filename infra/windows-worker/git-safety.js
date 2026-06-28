const fs = require("fs");
const path = require("path");

function normalizeGitPath(filePath) {
  const raw = String(filePath || "").replace(/\0/g, "");
  let normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/").trim();

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function uniqueSortedPaths(paths) {
  return [...new Set(paths.map(normalizeGitPath).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function parseGitStatusPorcelain(output) {
  const entries = [];
  const parts = String(output || "").split("\0").filter(Boolean);

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];

    if (record.length < 4) {
      continue;
    }

    const status = record.slice(0, 2);
    const filePath = normalizeGitPath(record.slice(3));

    if (!filePath) {
      continue;
    }

    if (status[0] === "R" || status[0] === "C") {
      const originalPath = normalizeGitPath(parts[index + 1] || "");
      index += 1;

      entries.push({
        status,
        path: filePath,
        originalPath,
        paths: [filePath],
      });
      continue;
    }

    entries.push({
      status,
      path: filePath,
      originalPath: null,
      paths: [filePath],
    });
  }

  return entries;
}

function formatPathList(paths) {
  return uniqueSortedPaths(paths).map((filePath) => `- ${filePath}`).join("\n");
}

function formatStatusList(entries) {
  return entries
    .flatMap((entry) =>
      entry.paths.map((filePath) => `- ${entry.status} ${normalizeGitPath(filePath)}`)
    )
    .join("\n");
}

function getStatusPaths(entries) {
  return uniqueSortedPaths(entries.flatMap((entry) => entry.paths || []));
}

function getTrackedStatusPaths(entries) {
  return uniqueSortedPaths(
    entries
      .filter((entry) => entry.status !== "??")
      .flatMap((entry) => entry.paths || [])
  );
}

function comparePathSets(expectedPaths, actualPaths) {
  const expected = uniqueSortedPaths(expectedPaths);
  const actual = uniqueSortedPaths(actualPaths);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    ok:
      expected.length === actual.length &&
      expected.every((filePath) => actualSet.has(filePath)),
    expected,
    actual,
    missing: expected.filter((filePath) => !actualSet.has(filePath)),
    extra: actual.filter((filePath) => !expectedSet.has(filePath)),
  };
}

function assertCleanStatusEntries(entries) {
  if (!entries || entries.length === 0) {
    return;
  }

  throw new Error(
    [
      "任务开始前 Git 工作区不干净，本次任务拒绝执行。",
      "请先手工处理以下文件后再重试；以下仅列出文件路径和状态，不包含文件内容：",
      formatStatusList(entries),
    ].join("\n")
  );
}

function isSensitivePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  const lower = normalized.toLowerCase();
  const baseName = lower.split("/").filter(Boolean).pop() || lower;
  const parts = lower.split("/").filter(Boolean);

  if (baseName === ".env.example") {
    return false;
  }

  if (
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    baseName.endsWith(".env")
  ) {
    return true;
  }

  if (parts.includes("logs")) {
    return true;
  }

  return baseName.endsWith(".bak");
}

const sensitiveContentRules = [
  {
    name: "WORKER_TOKEN",
    pattern: /\bWORKER_TOKEN\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    pattern: /\bSUPABASE_SERVICE_ROLE_KEY\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "FEISHU_APP_SECRET",
    pattern: /\bFEISHU_APP_SECRET\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "GITHUB_TOKEN",
    pattern: /\bGITHUB_TOKEN\b\s*[:=]\s*["']?[^\s"']{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}/i,
  },
  {
    name: "password",
    pattern: /\bpassword\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bprivate[_-]?key\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
];

function scanSensitiveContent(content) {
  const text = String(content || "");
  return sensitiveContentRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.name);
}

function resolveInsideRoot(projectRoot, filePath) {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, normalizeGitPath(filePath));

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return absolutePath;
}

function scanFileForSensitiveContent(projectRoot, filePath) {
  const absolutePath = resolveInsideRoot(projectRoot, filePath);

  if (!absolutePath) {
    return ["outside project root"];
  }

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const stat = fs.statSync(absolutePath);

  if (!stat.isFile()) {
    return [];
  }

  const maxBytesToScan = 1024 * 1024;
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytesToScan));
  const fd = fs.openSync(absolutePath, "r");

  try {
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  return scanSensitiveContent(buffer.toString("utf8"));
}

function validateCommittablePaths(paths, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const findings = [];

  for (const filePath of uniqueSortedPaths(paths)) {
    if (isSensitivePath(filePath)) {
      findings.push({
        path: normalizeGitPath(filePath),
        rule: "sensitive path",
      });
      continue;
    }

    for (const rule of scanFileForSensitiveContent(projectRoot, filePath)) {
      findings.push({
        path: normalizeGitPath(filePath),
        rule,
      });
    }
  }

  if (findings.length > 0) {
    throw new Error(
      [
        "检测到禁止提交的文件，本次任务拒绝提交。",
        "以下仅列出文件路径和规则名称，不包含文件内容：",
        ...findings.map((finding) => `- ${finding.path} (${finding.rule})`),
      ].join("\n")
    );
  }
}

function validateStagedPaths(taskPaths, stagedPaths) {
  const normalizeForCompare = (value) =>
    String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

  const uniqueSorted = (values) =>
    Array.from(new Set((values || []).map(normalizeForCompare).filter(Boolean))).sort();

  const expectedPaths = uniqueSorted(taskPaths);
  const actualPaths = uniqueSorted(stagedPaths);

  const isSameOrInside = (expected, actual) => {
    const parent = normalizeForCompare(expected);
    const child = normalizeForCompare(actual);

    if (!parent || !child) return false;
    if (child === parent) return true;
    return child.startsWith(parent + "/");
  };

  const extraStagedPaths = actualPaths.filter(
    (actualPath) => !expectedPaths.some((expectedPath) => isSameOrInside(expectedPath, actualPath))
  );

  const missingStagedPaths = expectedPaths.filter(
    (expectedPath) => !actualPaths.some((actualPath) => isSameOrInside(expectedPath, actualPath))
  );

  if (extraStagedPaths.length > 0 || missingStagedPaths.length > 0) {
    const details = [
      "Git 暂存结果与本次任务文件不一致，已取消本次暂存。",
      "以下仅列出文件路径，不包含文件内容：",
    ];

    if (extraStagedPaths.length > 0) {
      details.push("额外暂存文件：");
      for (const path of extraStagedPaths) {
        details.push("- " + path);
      }
    }

    if (missingStagedPaths.length > 0) {
      details.push("缺少暂存文件：");
      for (const path of missingStagedPaths) {
        details.push("- " + path);
      }
    }

    throw new Error(details.join("\n"));
  }

  return actualPaths;
}

module.exports = {
  assertCleanStatusEntries,
  comparePathSets,
  formatPathList,
  formatStatusList,
  getStatusPaths,
  getTrackedStatusPaths,
  isSensitivePath,
  normalizeGitPath,
  parseGitStatusPorcelain,
  scanSensitiveContent,
  uniqueSortedPaths,
  validateCommittablePaths,
  validateStagedPaths,
};
