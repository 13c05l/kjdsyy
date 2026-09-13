const XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(number) {
  let result = "";
  let value = number;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value) {
  return new Uint8Array([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255
  ]);
}

function concatBytes(...arrays) {
  const size = arrays.reduce((total, array) => total + array.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const checksum = crc32(data);
    const local = concatBytes(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, data
    );
    localParts.push(local);

    const central = concatBytes(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(checksum), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes
    );
    centralParts.push(central);
    offset += local.length;
  }

  const centralDirectory = concatBytes(...centralParts);
  const localDirectory = concatBytes(...localParts);
  const end = concatBytes(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
    u32(centralDirectory.length), u32(localDirectory.length), u16(0)
  );
  return concatBytes(localDirectory, centralDirectory, end);
}

function cellXml(rowNumber, columnNumber, value, type = "inlineStr", style = "") {
  const ref = `${columnName(columnNumber)}${rowNumber}`;
  const styleAttribute = style ? ` s="${style}"` : "";
  if (type === "n") return `<c r="${ref}"${styleAttribute}><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function worksheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const number = rowIndex + 1;
    return `<row r="${number}">${row.map((value, colIndex) => {
      const numeric = typeof value === "number" && Number.isFinite(value);
      return cellXml(number, colIndex + 1, numeric ? value : value ?? "", numeric ? "n" : "inlineStr", number === 1 ? "1" : "");
    }).join("")}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${XLSX_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>
    <col min="1" max="1" width="6" customWidth="1"/>
    <col min="2" max="2" width="46" customWidth="1"/>
    <col min="3" max="3" width="14" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="13" width="10" customWidth="1"/>
    <col min="14" max="14" width="30" customWidth="1"/>
    <col min="15" max="16" width="52" customWidth="1"/>
    <col min="17" max="21" width="20" customWidth="1"/>
  </cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function workbookFiles(rows) {
  const worksheet = worksheetXml(rows);
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${XLSX_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="市场调研" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${XLSX_NS}">
  <fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="D9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0"/></cellXfs>
</styleSheet>`,
    "xl/worksheets/sheet1.xml": worksheet
  };
}

export function buildXlsx(items, meta = {}) {
  if (meta.priceOnly) return buildPriceOnlyXlsx(items, meta);
  const headers = [
    "排名", "标题", "价格", "模型判断", "综合相似度", "标题关键词匹配",
    "产品类型", "核心功能", "外形", "结构", "材质", "成本", "本地初筛", "识别说明",
    "商品链接", "图片链接", "卖家", "运费", "商品状态", "关键词", "采集时间"
  ];
  const percent = (value) => (Number.isFinite(value) ? Math.round(value * 100) : "");
  const rows = [headers, ...items.map((item) => [
    item.rank,
    item.title,
    item.price,
    item.verdict || (item.error ? "识别失败" : ""),
    percent(item.finalScore),
    percent(item.textScore),
    percent(item.scores?.productType),
    percent(item.scores?.function),
    percent(item.scores?.shape),
    percent(item.scores?.structure),
    percent(item.scores?.material),
    percent(item.scores?.cost),
    percent(item.localScore),
    item.reason || item.error || "",
    item.url,
    item.imageUrl,
    item.seller,
    item.shipping,
    item.condition,
    item.query || meta.query || "",
    item.collectedAt || meta.collectedAt || ""
  ])];
  const bytes = zipStore(workbookFiles(rows));
  return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function buildPriceOnlyXlsx(items, meta = {}) {
  const headers = ["排名", "标题", "价格", "模型判断", "综合相似度", "图像粗筛", "识别说明", "商品链接", "图片链接", "关键词", "平台"];
  const percent = (value) => (Number.isFinite(value) ? Math.round(value * 100) : "");
  const rows = [headers, ...items.map((item) => [
    item.rank,
    item.title,
    item.price,
    item.verdict || (item.error ? "识别失败" : ""),
    percent(item.finalScore),
    percent(item.localScore),
    item.reason || item.error || "",
    item.url,
    item.imageUrl,
    item.query || meta.query || "",
    meta.platformLabel || meta.platform || ""
  ])];
  const bytes = zipStore(workbookFiles(rows));
  return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function downloadXlsx(items, meta = {}) {
  const blob = buildXlsx(items, meta);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "market-research-" + (meta.platform || "products") + "-" + new Date().toISOString().slice(0, 10) + ".xlsx";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
