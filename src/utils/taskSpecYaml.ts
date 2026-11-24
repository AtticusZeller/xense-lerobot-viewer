import type {
  TaskSpec,
  TaskSpecSubtask,
} from "@/types/subtask-annotation.types";

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inDouble) {
      if (ch === "\\" && i + 1 < value.length) {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteScalar(raw: string): string {
  const trimmed = stripInlineComment(raw).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(["\\nrt])/g, (_match, esc: string) => {
      switch (esc) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return esc;
      }
    });
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inDouble) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && text[i + 1] === "'") {
        current += "'";
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function parseFlowStringList(raw: string): string[] {
  const cleaned = stripInlineComment(raw).trim();
  if (!cleaned.startsWith("[") || !cleaned.endsWith("]")) {
    throw new Error(`Expected YAML list, got ${JSON.stringify(raw)}`);
  }
  const inner = cleaned.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevelCommas(inner)
    .map((item) => unquoteScalar(item))
    .filter(Boolean);
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\" && i + 1 < line.length) i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && line[i + 1] === "'") i += 1;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === ":" && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      const key = unquoteScalar(line.slice(0, i));
      const value = line.slice(i + 1).trim();
      return { key, value };
    }
  }
  return null;
}

function parseFlowSubtaskObject(raw: string): Partial<TaskSpecSubtask> {
  const cleaned = stripInlineComment(raw).trim();
  const inner = cleaned.slice(1, -1).trim();
  const entry: Partial<TaskSpecSubtask> = {};
  for (const part of splitTopLevelCommas(inner)) {
    const kv = parseKeyValue(part);
    if (!kv) continue;
    if (kv.key === "name") entry.name = unquoteScalar(kv.value);
    else if (kv.key === "prompt") entry.prompt = unquoteScalar(kv.value);
    else if (kv.key === "cameras") {
      entry.cameras = parseFlowStringList(kv.value);
    }
  }
  return entry;
}

interface RawLine {
  indent: number;
  content: string;
  raw: string;
}

function preprocessLines(text: string): RawLine[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result: RawLine[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    result.push({ indent, content: raw.slice(indent), raw });
  }
  return result;
}

export function parseTaskSpecYaml(text: string): TaskSpec {
  const lines = preprocessLines(text);
  let name = "";
  const rawSubtasks: Partial<TaskSpecSubtask>[] = [];
  let foundSubtasks = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent !== 0) continue;

    const topKv = parseKeyValue(line.content);
    if (!topKv) continue;

    if (topKv.key === "name") {
      name = unquoteScalar(topKv.value);
      continue;
    }

    if (topKv.key !== "subtasks") {
      continue;
    }

    foundSubtasks = true;
    const inlineValue = stripInlineComment(topKv.value).trim();
    if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
      const inner = inlineValue.slice(1, -1).trim();
      if (inner) {
        for (const item of splitTopLevelCommas(inner)) {
          if (item.startsWith("{") && item.endsWith("}")) {
            rawSubtasks.push(parseFlowSubtaskObject(item));
          }
        }
      }
      continue;
    }

    let current: Partial<TaskSpecSubtask> | null = null;
    let itemIndent: number | null = null;

    while (i + 1 < lines.length && lines[i + 1].indent > 0) {
      i += 1;
      const subLine = lines[i];

      if (itemIndent === null) {
        itemIndent = subLine.indent;
      }

      if (subLine.indent === itemIndent && /^-\s/.test(subLine.content)) {
        const afterDash = subLine.content.replace(/^-\s+/, "").trim();
        if (afterDash.startsWith("{") && afterDash.endsWith("}")) {
          current = parseFlowSubtaskObject(afterDash);
          rawSubtasks.push(current);
          continue;
        }
        current = {};
        rawSubtasks.push(current);
        const kv = parseKeyValue(afterDash);
        if (kv) {
          i = assignSubtaskField(current, kv.key, kv.value, lines, i);
        }
        continue;
      }

      if (subLine.indent === itemIndent && subLine.content === "-") {
        current = {};
        rawSubtasks.push(current);
        continue;
      }

      if (current) {
        const kv = parseKeyValue(subLine.content);
        if (kv) {
          i = assignSubtaskField(current, kv.key, kv.value, lines, i);
        }
      }
    }
  }

  if (!foundSubtasks || rawSubtasks.length === 0) {
    throw new Error("Task spec 'subtasks' must be a non-empty list");
  }

  const seen = new Set<string>();
  const subtasks: TaskSpecSubtask[] = rawSubtasks.map((entry, idx) => {
    const subtaskName = entry.name?.trim() ?? "";
    const prompt = entry.prompt?.trim() ?? "";
    if (!subtaskName) {
      throw new Error(`subtasks[${idx}].name must be a non-empty string`);
    }
    if (!prompt) {
      throw new Error(`subtasks[${idx}].prompt must be a non-empty string`);
    }
    if (seen.has(subtaskName)) {
      throw new Error(`Duplicate subtask name: ${JSON.stringify(subtaskName)}`);
    }
    seen.add(subtaskName);
    return entry.cameras !== undefined
      ? { name: subtaskName, prompt, cameras: entry.cameras }
      : { name: subtaskName, prompt };
  });

  return { name, subtasks };
}

function assignSubtaskField(
  target: Partial<TaskSpecSubtask>,
  key: string,
  value: string,
  lines: RawLine[],
  lineIdx: number,
): number {
  const keyIndent = lines[lineIdx].indent;
  const cleaned = stripInlineComment(value).trim();

  if (key === "name") {
    target.name = unquoteScalar(value);
    return lineIdx;
  }

  if (key === "prompt") {
    if (
      cleaned === "|" ||
      cleaned === ">" ||
      cleaned === "|-" ||
      cleaned === ">-"
    ) {
      const folded = cleaned.startsWith(">");
      const blockLines: string[] = [];
      let cursor = lineIdx;
      while (
        cursor + 1 < lines.length &&
        lines[cursor + 1].indent > keyIndent
      ) {
        cursor += 1;
        blockLines.push(lines[cursor].content.trimEnd());
      }
      target.prompt = folded ? blockLines.join(" ") : blockLines.join("\n");
      return cursor;
    }
    target.prompt = unquoteScalar(value);
    return lineIdx;
  }

  if (key === "cameras") {
    if (cleaned.startsWith("[")) {
      target.cameras = parseFlowStringList(cleaned);
      return lineIdx;
    }
    const cameras: string[] = [];
    let cursor = lineIdx;
    while (cursor + 1 < lines.length && lines[cursor + 1].indent > keyIndent) {
      const next = lines[cursor + 1];
      if (!/^-\s+/.test(next.content)) break;
      cursor += 1;
      const cam = unquoteScalar(next.content.replace(/^-\s+/, ""));
      if (cam) cameras.push(cam);
    }
    target.cameras = cameras;
    return cursor;
  }

  return lineIdx;
}
