import {
  VALID_SUBTASK_ANNOTATORS,
  type SubtaskAnnotationRow,
  type SubtaskAnnotator,
} from "@/types/subtask-annotation.types";

export const SUBTASK_CSV_COLUMNS = [
  "repo_id",
  "revision",
  "episode_index",
  "subtask",
  "start",
  "end",
  "contact",
  "grasp",
  "success",
  "annotator",
  "note",
] as const;

type CsvColumn = (typeof SUBTASK_CSV_COLUMNS)[number];

export interface ParsedCsvRecord {
  row: SubtaskAnnotationRow;
  rawRecord: string;
}

export interface ParsedSubtaskCsv {
  headerRecord: string;
  columns: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  records: ParsedCsvRecord[];
}

interface RawCsvRecord {
  fields: string[];
  raw: string;
  lineNumber: number;
}

function splitCsvRecords(text: string): {
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  records: RawCsvRecord[];
} {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  const records: RawCsvRecord[] = [];

  let i = 0;
  let lineNumber = 1;
  const len = text.length;

  while (i < len) {
    const recordStart = i;
    const recordLine = lineNumber;
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    let fieldStart = true;

    while (i < len) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        if (ch === "\n") lineNumber += 1;
        field += ch;
        i += 1;
        continue;
      }

      if (fieldStart && ch === '"') {
        inQuotes = true;
        fieldStart = false;
        i += 1;
        continue;
      }

      if (ch === ",") {
        fields.push(field);
        field = "";
        fieldStart = true;
        i += 1;
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        const raw = text.slice(recordStart, i);
        fields.push(field);
        if (ch === "\r" && i + 1 < len && text[i + 1] === "\n") {
          i += 2;
        } else {
          i += 1;
        }
        lineNumber += 1;
        records.push({ fields, raw, lineNumber: recordLine });
        field = "";
        fieldStart = true;
        break;
      }

      field += ch;
      fieldStart = false;
      i += 1;
    }

    if (inQuotes) {
      throw new Error(`Line ${recordLine}: unterminated quoted CSV field`);
    }

    if (i === len && recordStart < len) {
      const prevEndedRecord =
        records.length > 0 &&
        records[records.length - 1].lineNumber === recordLine;
      if (!prevEndedRecord) {
        const raw = text.slice(recordStart, len);
        fields.push(field);
        records.push({ fields, raw, lineNumber: recordLine });
      }
    }
  }

  return { eol, trailingNewline, records };
}

function parseRequiredInt(
  value: string,
  fieldName: string,
  lineNumber: number,
): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Line ${lineNumber}: invalid integer for '${fieldName}': ${JSON.stringify(value)}`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Line ${lineNumber}: integer out of range for '${fieldName}': ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseOptionalInt(
  value: string,
  fieldName: string,
  lineNumber: number,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseRequiredInt(trimmed, fieldName, lineNumber);
}

function parseBool(value: string, lineNumber: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(
    `Line ${lineNumber}: 'success' must be 'true' or 'false', got ${JSON.stringify(value)}`,
  );
}

function parseAnnotator(value: string, lineNumber: number): SubtaskAnnotator {
  const trimmed = value.trim();
  if ((VALID_SUBTASK_ANNOTATORS as readonly string[]).includes(trimmed)) {
    return trimmed as SubtaskAnnotator;
  }
  throw new Error(
    `Line ${lineNumber}: 'annotator' must be one of ${VALID_SUBTASK_ANNOTATORS.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

export function formatCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatSubtaskCsvRow(
  row: SubtaskAnnotationRow,
  columns: readonly string[] = SUBTASK_CSV_COLUMNS,
): string {
  const values: Record<CsvColumn, string> = {
    repo_id: row.repo_id,
    revision: row.revision,
    episode_index: String(row.episode_index),
    subtask: row.subtask,
    start: String(row.start),
    end: String(row.end),
    contact: row.contact === null ? "" : String(row.contact),
    grasp: row.grasp === null ? "" : String(row.grasp),
    success: row.success ? "true" : "false",
    annotator: row.annotator,
    note: row.note,
  };

  return columns
    .map((column) =>
      formatCsvCell(
        Object.prototype.hasOwnProperty.call(values, column)
          ? values[column as CsvColumn]
          : "",
      ),
    )
    .join(",");
}

export function parseSubtaskCsv(text: string): ParsedSubtaskCsv {
  const { eol, trailingNewline, records: rawRecords } = splitCsvRecords(text);
  if (rawRecords.length === 0) {
    throw new Error("Annotation CSV is empty (no header row)");
  }

  const header = rawRecords[0];
  const columns = header.fields.map((col, idx) =>
    idx === 0 ? col.replace(/^\uFEFF/, "") : col,
  );
  const indexByColumn = new Map<string, number>();
  columns.forEach((col, idx) => indexByColumn.set(col, idx));

  const missing = SUBTASK_CSV_COLUMNS.filter((col) => !indexByColumn.has(col));
  if (missing.length > 0) {
    throw new Error(
      `Annotation CSV is missing required columns: ${missing.join(", ")}`,
    );
  }

  const getField = (fields: string[], col: CsvColumn): string =>
    fields[indexByColumn.get(col)!] ?? "";

  const records: ParsedCsvRecord[] = [];
  for (let i = 1; i < rawRecords.length; i += 1) {
    const raw = rawRecords[i];
    if (raw.fields.length !== columns.length) {
      throw new Error(
        `Line ${raw.lineNumber}: expected ${columns.length} CSV columns, got ${raw.fields.length}`,
      );
    }
    const row: SubtaskAnnotationRow = {
      repo_id: getField(raw.fields, "repo_id").trim(),
      revision: getField(raw.fields, "revision").trim(),
      episode_index: parseRequiredInt(
        getField(raw.fields, "episode_index"),
        "episode_index",
        raw.lineNumber,
      ),
      subtask: getField(raw.fields, "subtask").trim(),
      start: parseRequiredInt(
        getField(raw.fields, "start"),
        "start",
        raw.lineNumber,
      ),
      end: parseRequiredInt(getField(raw.fields, "end"), "end", raw.lineNumber),
      contact: parseOptionalInt(
        getField(raw.fields, "contact"),
        "contact",
        raw.lineNumber,
      ),
      grasp: parseOptionalInt(
        getField(raw.fields, "grasp"),
        "grasp",
        raw.lineNumber,
      ),
      success: parseBool(getField(raw.fields, "success"), raw.lineNumber),
      annotator: parseAnnotator(
        getField(raw.fields, "annotator"),
        raw.lineNumber,
      ),
      note: getField(raw.fields, "note").trim(),
    };
    records.push({ row, rawRecord: raw.raw });
  }

  return {
    headerRecord: header.raw,
    columns,
    eol,
    trailingNewline,
    records,
  };
}

export function serializeSubtaskCsv(parsed: ParsedSubtaskCsv): string {
  const lines = [
    parsed.headerRecord,
    ...parsed.records.map((rec) => rec.rawRecord),
  ];
  const joined = lines.join(parsed.eol);
  return parsed.trailingNewline ? `${joined}${parsed.eol}` : joined;
}

export function serializeSubtaskRows(
  rows: readonly SubtaskAnnotationRow[],
  eol: "\n" | "\r\n" = "\n",
): string {
  const lines = [
    SUBTASK_CSV_COLUMNS.join(","),
    ...rows.map((row) => formatSubtaskCsvRow(row)),
  ];
  return `${lines.join(eol)}${eol}`;
}

export function rowContentEquals(
  a: Pick<
    SubtaskAnnotationRow,
    "subtask" | "start" | "end" | "contact" | "grasp" | "success" | "note"
  >,
  b: Pick<
    SubtaskAnnotationRow,
    "subtask" | "start" | "end" | "contact" | "grasp" | "success" | "note"
  >,
): boolean {
  return (
    a.subtask === b.subtask &&
    a.start === b.start &&
    a.end === b.end &&
    a.contact === b.contact &&
    a.grasp === b.grasp &&
    a.success === b.success &&
    a.note.trim() === b.note.trim()
  );
}

export function resolveDraftAnnotators(
  previousRows: readonly SubtaskAnnotationRow[],
  draftRows: readonly SubtaskAnnotationRow[],
): { rows: SubtaskAnnotationRow[]; changedIndices: Set<number> } {
  const usedPrev = new Set<number>();
  const changedIndices = new Set<number>();

  const rows = draftRows.map((draft, idx) => {
    const matchIdx = previousRows.findIndex(
      (prev, prevIdx) =>
        !usedPrev.has(prevIdx) && rowContentEquals(prev, draft),
    );
    if (matchIdx !== -1) {
      usedPrev.add(matchIdx);
      return {
        ...draft,
        note: draft.note.trim(),
        annotator: previousRows[matchIdx].annotator,
      };
    }
    changedIndices.add(idx);
    return {
      ...draft,
      note: draft.note.trim(),
      annotator: "human" as const,
    };
  });

  return { rows, changedIndices };
}

export function mergeEpisodeIntoCsv(
  existingCsvText: string | null,
  episodeIndex: number,
  nextEpisodeRows: readonly SubtaskAnnotationRow[],
  defaults: { repoId: string; revision: string },
): {
  csvText: string;
  updatedRows: SubtaskAnnotationRow[];
  changedRowCount: number;
} {
  if (!existingCsvText || !existingCsvText.trim()) {
    const normalized: SubtaskAnnotationRow[] = nextEpisodeRows.map((row) => ({
      ...row,
      repo_id: defaults.repoId,
      revision: defaults.revision,
      episode_index: episodeIndex,
      annotator: "human",
      note: row.note.trim(),
    }));
    return {
      csvText: serializeSubtaskRows(normalized),
      updatedRows: normalized,
      changedRowCount: normalized.length,
    };
  }

  const parsed = parseSubtaskCsv(existingCsvText);
  const existingEpisodeRecords = parsed.records.filter(
    (rec) => rec.row.episode_index === episodeIndex,
  );
  const usedPrev = new Set<number>();
  let changedRowCount = 0;

  const replacementRecords: ParsedCsvRecord[] = nextEpisodeRows.map((draft) => {
    const matchIdx = existingEpisodeRecords.findIndex(
      (prev, idx) => !usedPrev.has(idx) && rowContentEquals(prev.row, draft),
    );
    if (matchIdx !== -1) {
      usedPrev.add(matchIdx);
      return existingEpisodeRecords[matchIdx];
    }
    changedRowCount += 1;
    const row: SubtaskAnnotationRow = {
      repo_id: existingEpisodeRecords[0]?.row.repo_id || defaults.repoId,
      revision: existingEpisodeRecords[0]?.row.revision || defaults.revision,
      episode_index: episodeIndex,
      subtask: draft.subtask.trim(),
      start: draft.start,
      end: draft.end,
      contact: draft.contact,
      grasp: draft.grasp,
      success: draft.success,
      annotator: "human",
      note: draft.note.trim(),
    };
    return {
      row,
      rawRecord: formatSubtaskCsvRow(row, parsed.columns),
    };
  });

  const nextRecords: ParsedCsvRecord[] = [];
  if (existingEpisodeRecords.length > 0) {
    let inserted = false;
    for (const rec of parsed.records) {
      if (rec.row.episode_index === episodeIndex) {
        if (!inserted) {
          nextRecords.push(...replacementRecords);
          inserted = true;
        }
      } else {
        nextRecords.push(rec);
      }
    }
  } else {
    let inserted = false;
    for (const rec of parsed.records) {
      if (!inserted && rec.row.episode_index > episodeIndex) {
        nextRecords.push(...replacementRecords);
        inserted = true;
      }
      nextRecords.push(rec);
    }
    if (!inserted) {
      nextRecords.push(...replacementRecords);
    }
  }

  const csvText = serializeSubtaskCsv({
    ...parsed,
    records: nextRecords,
  });

  return {
    csvText,
    updatedRows: replacementRecords.map((rec) => rec.row),
    changedRowCount,
  };
}
