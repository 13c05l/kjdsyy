function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function rowsToRecords(rows) {
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((value, index) => String(value || "字段" + (index + 1)).trim() || "字段" + (index + 1));
  const records = rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  return { headers, rows: records };
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持读取压缩表格");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

async function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (readU32(view, index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error("不是有效的 XLSX 文件");
  const count = readU16(view, end + 10);
  const centralOffset = readU32(view, end + 16);
  const decoder = new TextDecoder();
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (readU32(view, cursor) !== 0x02014b50) throw new Error("XLSX 目录读取失败");
    const method = readU16(view, cursor + 10);
    const compressedSize = readU32(view, cursor + 20);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localOffset = readU32(view, cursor + 42);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : await inflateRaw(compressed);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function textFromEntry(entries, name) {
  const bytes = entries.get(name);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function sharedStringsFromXml(xml) {
  if (!xml) return [];
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return [...document.querySelectorAll("si")].map((node) => [...node.querySelectorAll("t")].map((part) => part.textContent || "").join(""));
}

function xlsxRows(entries) {
  const shared = sharedStringsFromXml(textFromEntry(entries, "xl/sharedStrings.xml"));
  const sheetName = [...entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!sheetName) throw new Error("XLSX 中没有可读取的工作表");
  const document = new DOMParser().parseFromString(textFromEntry(entries, sheetName), "application/xml");
  const rows = [];
  for (const row of document.querySelectorAll("row")) {
    const values = [];
    for (const cell of row.querySelectorAll("c")) {
      const ref = cell.getAttribute("r") || "";
      const match = ref.match(/^[A-Z]+/i);
      let column = 0;
      if (match) for (const char of match[0].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
      column -= 1;
      while (values.length <= column) values.push("");
      const type = cell.getAttribute("t");
      const value = cell.querySelector("v")?.textContent || "";
      values[column] = type === "s" ? (shared[Number(value)] || "") : type === "inlineStr" ? (cell.querySelector("t")?.textContent || "") : value;
    }
    if (values.some((value) => String(value).trim())) rows.push(values);
  }
  return rows;
}

export async function parseProductDataFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) {
    const payload = JSON.parse(await file.text());
    const records = Array.isArray(payload) ? payload : Array.isArray(payload.rows) ? payload.rows : [payload];
    const headers = [...new Set(records.flatMap((record) => Object.keys(record || {})))];
    return { headers, rows: records.map((record) => Object.fromEntries(headers.map((header) => [header, record?.[header] ?? ""]))) };
  }
  if (name.endsWith(".csv") || name.endsWith(".tsv")) {
    const text = await file.text();
    const delimiter = name.endsWith(".tsv") ? "\t" : text.split(/\r?\n/, 1)[0].includes("\t") ? "\t" : ",";
    return rowsToRecords(parseDelimited(text.replace(/^\ufeff/, ""), delimiter));
  }
  if (name.endsWith(".xlsx")) {
    return rowsToRecords(xlsxRows(await readZipEntries(await file.arrayBuffer())));
  }
  throw new Error("暂不支持该文件格式，请使用 XLSX、CSV、TSV 或 JSON");
}
