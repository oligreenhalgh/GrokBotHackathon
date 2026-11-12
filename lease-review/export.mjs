import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

// ExcelJS treats primitive strings as literal text. Formula cells require an explicit
// { formula: ... } value, which this exporter never creates. Preserve the existing
// export's prefix for +/@ text, while = text is stored literally. Empty text is blank.
const safe = value => value === '' || value === undefined ? null : typeof value === 'string' && /^[+@]/.test(value) ? "'" + value : value;
const effective = (row, column, state) => Object.hasOwn(state.overrides || {}, `${row.id}:${column.id}`) ? state.overrides[`${row.id}:${column.id}`].value : row.cells[column.id]?.value ?? null;
const fullLabel = column => ['Unit Information', 'Term'].includes(column.group) ? column.label : `${column.group}: ${column.label}`;
const color = hex => ({ argb: 'FF' + hex.replace('#', '') });
const fill = hex => ({ type: 'pattern', pattern: 'solid', fgColor: color(hex) });

function base(sheet, rowCount, columnCount) {
  sheet.views = [{ showGridLines: false }];
  for (let r = 1; r <= rowCount; r++) {
    sheet.getRow(r).height = 25;
    for (let c = 1; c <= columnCount; c++) {
      const cell = sheet.getCell(r, c);
      cell.font = { name: 'Helvetica', size: 10, color: color('#26333B') };
      cell.alignment = { vertical: 'middle' };
    }
  }
}
function band(sheet, row, startColumn, endColumn, background = '#741F34', foreground = '#FFFFFF') {
  for (let c = startColumn; c <= endColumn; c++) {
    const cell = sheet.getCell(row, c);
    cell.fill = fill(background);
    cell.font = { name: 'Helvetica', size: 10, bold: true, color: color(foreground) };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
  }
}
function mergedGroups(sheet, row, columns, property, background) {
  let start = 0;
  while (start < columns.length) {
    let end = start;
    while (end + 1 < columns.length && columns[end + 1][property] === columns[start][property]) end++;
    if (end > start) sheet.mergeCells(row, start + 1, row, end + 1);
    sheet.getCell(row, start + 1).value = columns[start][property];
    band(sheet, row, start + 1, end + 1, background);
    start = end + 1;
  }
}
function width(sheet, first, last, value) {
  for (let c = first; c <= last; c++) sheet.getColumn(c).width = value;
}

/** Portable XLSX export. Requires only Node.js and the public exceljs package. */
export async function exportWorkbook(workspace, outputPath, { previewDir } = {}) {
  const { columns, rows, documents } = workspace;
  const state = workspace.state || { reviews: {}, overrides: {}, audit: [] };
  if (columns.length !== 56) throw new Error('The rent-roll schema must have 56 columns.');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Rent roll review');
  const sources = workbook.addWorksheet('Source evidence');
  const lastRow = Math.max(rows.length + 6, 7);
  base(sheet, lastRow, columns.length);
  sheet.properties.tabColor = color('#741F34');
  width(sheet, 1, columns.length, 20);
  sheet.getCell('A2').value = 'Lease review';
  sheet.getCell('A2').font = { name: 'Helvetica', size: 15, bold: true };
  sheet.getCell('A3').value = 'Source-linked lease register. Blank values remain unknown. Review decisions and source passages are on Source evidence.';
  sheet.getCell('A3').font = { name: 'Helvetica', size: 10, italic: true, color: color('#64716B') };
  mergedGroups(sheet, 4, columns, 'section', '#741F34');
  mergedGroups(sheet, 5, columns, 'group', '#945266');
  sheet.getRow(6).values = columns.map(c => c.label);
  band(sheet, 6, 1, columns.length, '#F5EDEF', '#581327');
  sheet.getRow(6).height = 42;
  const numericColumns = new Set(['c01','c07','c10','c22','c23','c34','c35','c36','c40','c41','c43','c44','c45','c46','c47','c48','c49','c50']);
  for (let r = 7; r <= lastRow; r++) {
    sheet.getRow(r).height = 48;
    columns.forEach((column, c) => {
      const cell = sheet.getCell(r, c + 1);
      cell.alignment = { wrapText: true, vertical: 'top' };
      if (numericColumns.has(column.id)) cell.numFmt = ['c01','c10','c22'].includes(column.id) ? '#,##0' : '#,##0.00';
    });
  }
  rows.forEach((row, r) => columns.forEach((column, c) => {
    const key = `${row.id}:${column.id}`;
    const status = row.cells[column.id]?.status;
    const cell = sheet.getCell(r + 7, c + 1);
    cell.value = safe(effective(row, column, state));
    if (Object.hasOwn(state.overrides || {}, key)) cell.fill = fill('#E7EEFA');
    else if (state.reviews?.[key]) cell.fill = fill('#EDF3EC');
    else if (['placeholder','optional','needs_review'].includes(status)) cell.fill = fill('#FFF5DD');
    else if (r % 2) cell.fill = fill('#FCF9FA');
  }));
  width(sheet, 1, 1, 7); width(sheet, 2, 2, 18); width(sheet, 3, 6, 26);
  width(sheet, 9, 9, 40); width(sheet, 55, 56, 42);
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 6, topLeftCell: 'D7', activeCell: 'D7', showGridLines: false }];

  const headers = ['Row ID','Lease document','Column ID','Field','Effective value','Extracted value','Extraction status','Reviewed','Override note','Explanation','Source document','PDF page','Source quote','Source URL'];
  const evidenceRows = [];
  const documentMap = new Map(documents.map(document => [document.id, document]));
  for (const row of rows) {
    for (const column of columns) {
      const key = `${row.id}:${column.id}`;
      const cell = row.cells[column.id] || { value: null, status: 'not_found', explanation: '', evidence: [] };
      for (const ev of cell.evidence?.length ? cell.evidence : [null]) {
        const source = ev ? documentMap.get(ev.documentId) : null;
        evidenceRows.push([row.id, row.title, column.id, fullLabel(column), effective(row, column, state), cell.value,
          cell.status, Boolean(state.reviews?.[key]), state.overrides?.[key]?.note || '', cell.explanation,
          ev?.documentId || null, ev?.page || null, ev?.quote || null, source?.sourceUrl || null].map(safe));
      }
    }
  }
  const evidenceLast = Math.max(5, evidenceRows.length + 4);
  base(sources, evidenceLast, headers.length);
  sources.getCell('A2').value = 'Source evidence and review decisions';
  sources.getCell('A2').font = { name: 'Helvetica', size: 15, bold: true };
  sources.getCell('A3').value = 'One line per field and source passage. Extracted values are preserved alongside any reviewer overrides.';
  sources.getCell('A3').font = { name: 'Helvetica', size: 10, italic: true, color: color('#64716B') };
  sources.getRow(4).values = headers;
  band(sources, 4, 1, headers.length);
  sources.getRow(4).height = 30;
  evidenceRows.forEach((values, i) => { sources.getRow(i + 5).values = values; });
  width(sources, 1, 14, 22); width(sources, 2, 2, 34); width(sources, 4, 4, 32);
  width(sources, 9, 10, 60); width(sources, 13, 13, 90); width(sources, 14, 14, 75);
  for (let r = 5; r <= evidenceLast; r++) {
    sources.getRow(r).height = 75;
    for (let c = 1; c <= headers.length; c++) sources.getCell(r, c).alignment = { wrapText: true, vertical: 'top' };
  }
  sources.views = [{ state: 'frozen', xSplit: 4, ySplit: 4, topLeftCell: 'E5', activeCell: 'E5', showGridLines: false }];

  // ExcelJS writes strings as strings; no extracted text is evaluated as a formula.
  // Keep the optional diagnostics directory without requiring a platform-specific renderer.
  if (previewDir) {
    await fs.mkdir(previewDir, { recursive: true });
    const inspection = { sheet: sheet.name, range: 'A6:H10', values: [] };
    for (let r = 6; r <= Math.min(lastRow, 10); r++) inspection.values.push(Array.from({ length: 8 }, (_, c) => sheet.getCell(r, c + 1).value));
    await fs.writeFile(path.join(previewDir, 'export-inspect.ndjson'), JSON.stringify(inspection) + '\n');
    await fs.writeFile(path.join(previewDir, 'rendering.txt'), 'This portable exporter uses ExcelJS. PNG previews require an external spreadsheet renderer; the application XLSX export is unaffected.\n');
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return { path: outputPath, rows: rows.length, columns: columns.length, evidenceRows: evidenceRows.length };
}
