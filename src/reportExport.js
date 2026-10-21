const textEncoder = new TextEncoder();
const baseUrl = import.meta.env?.BASE_URL || '/';
const browserLocation = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
const regularFontUrl = new URL(`${baseUrl}fonts/THSarabunNew.ttf`, browserLocation).href;
const boldFontUrl = new URL(`${baseUrl}fonts/THSarabunNew-Bold.ttf`, browserLocation).href;

const CATEGORY_LABEL = {
  general: 'ผู้ป่วยทั่วไป',
  emergency: 'อุบัติเหตุ',
};

const STATUS_LABEL = {
  waiting: 'รอเรียก',
  called: 'กำลังเรียก',
  serving: 'กำลังให้บริการ',
  completed: 'เสร็จสิ้น',
  done: 'เสร็จสิ้น',
  skipped: 'ข้ามคิว',
  cancelled: 'ยกเลิก',
};

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeHtml(value) {
  return escapeXml(value);
}

let formalFontsReady;
function ensureFormalFonts() {
  if (!formalFontsReady) {
    formalFontsReady = Promise.all([
      new FontFace('TH Sarabun New', `url(${regularFontUrl})`, { weight: '400' }).load(),
      new FontFace('TH Sarabun New', `url(${boldFontUrl})`, { weight: '700' }).load(),
    ]).then(fonts => {
      fonts.forEach(font => document.fonts.add(font));
      return document.fonts.ready;
    });
  }
  return formalFontsReady;
}

function formatThaiDate(value, withTime = false) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    timeZone: 'Asia/Bangkok',
  }).format(date);
}

function fileSafe(value) {
  return String(value || 'รายงาน').replace(/[\\/:*?"<>|]/g, '-').replaceAll(' ', '-');
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function reportSummary(tickets) {
  return {
    total: tickets.length,
    general: tickets.filter(ticket => ticket.category !== 'emergency').length,
    emergency: tickets.filter(ticket => ticket.category === 'emergency').length,
    completed: tickets.filter(ticket => ['completed', 'done'].includes(ticket.status)).length,
  };
}

function reportRows(tickets) {
  return tickets.map((ticket, index) => ({
    order: index + 1,
    ticketCode: ticket.ticketCode || ticket.queue || '-',
    category: CATEGORY_LABEL[ticket.category] || 'ผู้ป่วยทั่วไป',
    status: STATUS_LABEL[ticket.status] || ticket.status || '-',
    servicePoint: ticket.currentPoint ? `จุดบริการ ${ticket.currentPoint}` : 'ไม่ระบุ',
    issuedAt: ticket.issuedAt || null,
    completedAt: ticket.completedAt || null,
  }));
}

function excelSerial(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return (timestamp + (7 * 60 * 60 * 1000)) / 86400000 + 25569;
}

function columnName(index) {
  let value = index;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function stringCell(reference, value, style = 4) {
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function numberCell(reference, value, style = 5) {
  return `<c r="${reference}" s="${style}"><v>${Number(value) || 0}</v></c>`;
}

function dateCell(reference, value) {
  const serial = excelSerial(value);
  return serial === null ? stringCell(reference, '-', 5) : `<c r="${reference}" s="6"><v>${serial}</v></c>`;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, tableIndex) => {
      let crc = tableIndex;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      return crc >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let localOffset = 0;
  for (const file of files) {
    const name = textEncoder.encode(file.name);
    const data = typeof file.data === 'string' ? textEncoder.encode(file.data) : file.data;
    const checksum = crc32(data);
    const localHeader = concatBytes([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(time), uint16(date),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name,
    ]);
    localParts.push(localHeader, data);
    centralParts.push(concatBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(time), uint16(date),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(localOffset), name,
    ]));
    localOffset += localHeader.length + data.length;
  }
  const central = concatBytes(centralParts);
  const end = concatBytes([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(central.length), uint32(localOffset), uint16(0),
  ]);
  return concatBytes([...localParts, central, end]);
}

function createLegacyExcelReportBlob({ tickets, periodLabel, startDate, endDate }) {
  const rows = reportRows(tickets);
  const summary = reportSummary(tickets);
  const generatedAt = new Date();
  const detailStartRow = 12;
  const detailRows = rows.map((row, rowIndex) => {
    const excelRow = detailStartRow + rowIndex;
    return `<row r="${excelRow}" ht="23">${[
      numberCell(`A${excelRow}`, row.order),
      stringCell(`B${excelRow}`, row.ticketCode, 5),
      stringCell(`C${excelRow}`, row.category),
      stringCell(`D${excelRow}`, row.status),
      stringCell(`E${excelRow}`, row.servicePoint),
      dateCell(`F${excelRow}`, row.issuedAt),
      dateCell(`G${excelRow}`, row.completedAt),
    ].join('')}</row>`;
  }).join('');
  const lastRow = Math.max(detailStartRow, detailStartRow + rows.length - 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="11" topLeftCell="A12" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="15" customWidth="1"/><col min="3" max="5" width="22" customWidth="1"/><col min="6" max="7" width="23" customWidth="1"/></cols><sheetData>
<row r="1" ht="32">${stringCell('A1', 'รายงานสรุปการให้บริการ QueueFlow', 1)}</row>
<row r="2" ht="25">${stringCell('A2', 'สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน', 2)}</row>
<row r="4">${stringCell('A4', 'ช่วงเวลา', 3)}${stringCell('B4', periodLabel, 4)}${stringCell('D4', 'ช่วงข้อมูล', 3)}${stringCell('E4', `${formatThaiDate(startDate)} ถึง ${formatThaiDate(endDate)}`, 4)}</row>
<row r="5">${stringCell('A5', 'วันที่จัดทำ', 3)}${stringCell('B5', formatThaiDate(generatedAt, true), 4)}</row>
<row r="7" ht="25">${stringCell('A7', 'สรุปจำนวนคิว', 7)}</row>
<row r="8">${stringCell('A8', 'คิวทั้งหมด', 3)}${numberCell('B8', summary.total, 8)}${stringCell('C8', 'ผู้ป่วยทั่วไป', 3)}${numberCell('D8', summary.general, 8)}${stringCell('E8', 'อุบัติเหตุ', 3)}${numberCell('F8', summary.emergency, 8)}</row>
<row r="9">${stringCell('A9', 'เสร็จสิ้น', 3)}${numberCell('B9', summary.completed, 8)}</row>
<row r="11" ht="27">${['ลำดับ', 'หมายเลขคิว', 'ประเภท', 'สถานะ', 'จุดบริการปัจจุบัน', 'เวลาออกบัตร', 'เวลาเสร็จสิ้น'].map((header, index) => stringCell(`${columnName(index + 1)}11`, header, 3)).join('')}</row>
${detailRows || `<row r="12"><c r="A12" t="inlineStr" s="5"><is><t>ไม่มีข้อมูลคิวในช่วงเวลานี้</t></is></c></row>`}
</sheetData><mergeCells count="3"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/><mergeCell ref="A7:G7"/></mergeCells><autoFilter ref="A11:G${lastRow}"/><pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="18"/><color rgb="FF293681"/><name val="Tahoma"/></font><font><b/><sz val="13"/><color rgb="FF4A5A72"/><name val="Tahoma"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF293681"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD7E0FF"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD4D9E2"/></left><right style="thin"><color rgb="FFD4D9E2"/></right><top style="thin"><color rgb="FFD4D9E2"/></top><bottom style="thin"><color rgb="FFD4D9E2"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="รายงานคิว" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'รายงานคิว'!$11:$11</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">'รายงานคิว'!$A$1:$G$${lastRow}</definedName></definedNames><calcPr calcId="191029"/></workbook>`;
  const formalStyles = styles.replaceAll('Tahoma', 'TH Sarabun New');
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: formalStyles },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>รายงานสรุปการให้บริการ QueueFlow</dc:title><dc:creator>QueueFlow</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt.toISOString()}</dcterms:created></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>QueueFlow</Application></Properties>` },
  ];
  return new Blob([createZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function createExcelReportBlob({ tickets, periodLabel, startDate, endDate }) {
  const { default: ExcelJS } = await import('exceljs');
  const rows = reportRows(tickets);
  const summary = reportSummary(tickets);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'QueueFlow';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'รายงานสรุปการให้บริการ';
  const worksheet = workbook.addWorksheet('รายงานคิว', {
    views: [{ state: 'frozen', ySplit: 11, activeCell: 'A12' }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  worksheet.columns = [
    { key: 'order', width: 10 },
    { key: 'ticketCode', width: 16 },
    { key: 'category', width: 22 },
    { key: 'status', width: 22 },
    { key: 'servicePoint', width: 24 },
    { key: 'issuedAt', width: 24 },
    { key: 'completedAt', width: 24 },
  ];
  worksheet.mergeCells('A1:G1');
  worksheet.getCell('A1').value = 'รายงานสรุปการให้บริการ QueueFlow';
  worksheet.getCell('A1').font = { name: 'TH Sarabun New', size: 22, bold: true, color: { argb: 'FF293681' } };
  worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(1).height = 34;
  worksheet.mergeCells('A2:G2');
  worksheet.getCell('A2').value = 'สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน';
  worksheet.getCell('A2').font = { name: 'TH Sarabun New', size: 17, bold: true };
  worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(2).height = 27;
  worksheet.getCell('A4').value = 'ช่วงเวลา';
  worksheet.getCell('B4').value = periodLabel || '-';
  worksheet.getCell('D4').value = 'ช่วงข้อมูล';
  worksheet.getCell('E4').value = `${formatThaiDate(startDate)} ถึง ${formatThaiDate(endDate)}`;
  worksheet.getCell('A5').value = 'วันที่จัดทำ';
  worksheet.getCell('B5').value = `${formatThaiDate(new Date(), true)} น.`;
  worksheet.mergeCells('A7:G7');
  worksheet.getCell('A7').value = 'สรุปจำนวนคิว';
  worksheet.getCell('A7').font = { name: 'TH Sarabun New', size: 17, bold: true };
  worksheet.getCell('A8').value = 'คิวทั้งหมด';
  worksheet.getCell('B8').value = summary.total;
  worksheet.getCell('C8').value = 'ผู้ป่วยทั่วไป';
  worksheet.getCell('D8').value = summary.general;
  worksheet.getCell('E8').value = 'อุบัติเหตุ';
  worksheet.getCell('F8').value = summary.emergency;
  worksheet.getCell('A9').value = 'เสร็จสิ้น';
  worksheet.getCell('B9').value = summary.completed;
  const headers = ['ลำดับ', 'หมายเลขคิว', 'ประเภท', 'สถานะ', 'จุดบริการปัจจุบัน', 'เวลาออกบัตร', 'เวลาเสร็จสิ้น'];
  worksheet.getRow(11).values = headers;
  worksheet.getRow(11).height = 28;
  worksheet.getRow(11).eachCell(cell => {
    cell.font = { name: 'TH Sarabun New', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF293681' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });
  if (rows.length) {
    rows.forEach(row => {
      const excelRow = worksheet.addRow([
        row.order,
        row.ticketCode,
        row.category,
        row.status,
        row.servicePoint,
        formatThaiDate(row.issuedAt, true),
        formatThaiDate(row.completedAt, true),
      ]);
      excelRow.height = 24;
      excelRow.eachCell((cell, columnNumber) => {
        cell.font = { name: 'TH Sarabun New', size: 14 };
        cell.alignment = { horizontal: [1, 2].includes(columnNumber) ? 'center' : 'left', vertical: 'middle' };
        cell.border = { top: { style: 'thin', color: { argb: 'FFD4D9E2' } }, left: { style: 'thin', color: { argb: 'FFD4D9E2' } }, bottom: { style: 'thin', color: { argb: 'FFD4D9E2' } }, right: { style: 'thin', color: { argb: 'FFD4D9E2' } } };
      });
    });
  } else {
    worksheet.mergeCells('A12:G12');
    worksheet.getCell('A12').value = 'ไม่มีข้อมูลคิวในช่วงเวลานี้';
    worksheet.getCell('A12').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getCell('A12').font = { name: 'TH Sarabun New', size: 14 };
  }
  for (const reference of ['A4', 'D4', 'A5', 'A8', 'C8', 'E8', 'A9']) {
    const cell = worksheet.getCell(reference);
    cell.font = { name: 'TH Sarabun New', size: 14, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7E0FF' } };
  }
  for (const reference of ['B4', 'E4', 'B5', 'B8', 'D8', 'F8', 'B9']) {
    worksheet.getCell(reference).font = { name: 'TH Sarabun New', size: 14 };
  }
  const lastRow = Math.max(12, worksheet.rowCount);
  worksheet.autoFilter = `A11:G${lastRow}`;
  worksheet.pageSetup.printArea = `A1:G${lastRow}`;
  worksheet.pageSetup.printTitlesRow = '11:11';
  worksheet.headerFooter.oddFooter = '&LQueueFlow&Cหน้า &P จาก &N&R&D &T';
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) return reject(new Error('ไม่สามารถสร้างหน้ารายงาน PDF ได้'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', 0.9);
  });
}

function drawReportPage({ rows, pageNumber, pageCount, periodLabel, startDate, endDate, summary }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754;
  const context = canvas.getContext('2d');
  const regular = '"TH Sarabun New", sans-serif';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = `bold 48px ${regular}`;
  context.textAlign = 'center';
  context.fillText('รายงานสรุปการให้บริการ', 620, 68);
  context.font = `bold 31px ${regular}`;
  context.fillText('สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน', 620, 111);
  context.strokeStyle = '#111111';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(55, 139);
  context.lineTo(1185, 139);
  context.stroke();

  context.textAlign = 'left';
  context.font = `28px ${regular}`;
  context.fillText(`ช่วงเวลา: ${periodLabel || '-'}`, 65, 184);
  context.fillText(`ข้อมูลระหว่าง: ${formatThaiDate(startDate)} ถึง ${formatThaiDate(endDate)}`, 65, 224);
  context.fillText(`วันที่จัดทำ: ${formatThaiDate(new Date(), true)} น.`, 65, 264);

  const cards = [
    ['คิวทั้งหมด', summary.total],
    ['ผู้ป่วยทั่วไป', summary.general],
    ['อุบัติเหตุ', summary.emergency],
    ['เสร็จสิ้น', summary.completed],
  ];
  cards.forEach(([label, value], index) => {
    const x = 55 + index * 282.5;
    context.fillStyle = index % 2 ? '#ffffff' : '#f2f2f2';
    context.fillRect(x, 292, 282.5, 72);
    context.strokeStyle = '#555555';
    context.lineWidth = 1;
    context.strokeRect(x, 292, 282.5, 72);
    context.fillStyle = '#111111';
    context.font = `26px ${regular}`;
    context.textAlign = 'center';
    context.fillText(`${label}  ${value} คิว`, x + 141.25, 337);
  });

  const columns = [
    { label: 'ลำดับ', x: 55, width: 85, align: 'center' },
    { label: 'หมายเลขคิว', x: 140, width: 155, align: 'center' },
    { label: 'ประเภท', x: 295, width: 190, align: 'left' },
    { label: 'สถานะ', x: 485, width: 180, align: 'left' },
    { label: 'จุดบริการ', x: 665, width: 160, align: 'left' },
    { label: 'เวลาออกบัตร', x: 825, width: 180, align: 'left' },
    { label: 'เวลาเสร็จสิ้น', x: 1005, width: 180, align: 'left' },
  ];
  const headerY = 400;
  const rowHeight = 54;
  context.fillStyle = '#e6e6e6';
  context.fillRect(55, headerY, 1130, rowHeight);
  context.strokeStyle = '#333333';
  context.strokeRect(55, headerY, 1130, rowHeight);
  context.fillStyle = '#111111';
  context.font = `bold 24px ${regular}`;
  columns.forEach(column => {
    context.textAlign = column.align === 'center' ? 'center' : 'left';
    context.fillText(column.label, column.align === 'center' ? column.x + column.width / 2 : column.x + 10, headerY + 36);
  });
  if (!rows.length) {
    context.fillStyle = '#333333';
    context.textAlign = 'center';
    context.font = `28px ${regular}`;
    context.fillText('ไม่มีข้อมูลคิวในช่วงเวลานี้', 620, headerY + 110);
  }
  rows.forEach((row, index) => {
    const y = headerY + rowHeight + index * rowHeight;
    context.fillStyle = index % 2 ? '#f7f7f7' : '#ffffff';
    context.fillRect(55, y, 1130, rowHeight);
    context.strokeStyle = '#777777';
    context.strokeRect(55, y, 1130, rowHeight);
    const values = [row.order, row.ticketCode, row.category, row.status, row.servicePoint.replace('จุดบริการ ', 'จุด '), formatThaiDate(row.issuedAt, true), formatThaiDate(row.completedAt, true)];
    context.fillStyle = '#111111';
    context.font = `24px ${regular}`;
    columns.forEach((column, columnIndex) => {
      context.textAlign = column.align === 'center' ? 'center' : 'left';
      const x = column.align === 'center' ? column.x + column.width / 2 : column.x + 10;
      context.fillText(String(values[columnIndex]), x, y + 36, column.width - 18);
    });
  });

  if (pageNumber === pageCount) {
    context.fillStyle = '#111111';
    context.font = `24px ${regular}`;
    context.textAlign = 'left';
    context.fillText('หมายเหตุ: รายงานนี้จัดทำจากข้อมูลการให้บริการที่บันทึกในระบบ QueueFlow', 65, 1485);
    context.textAlign = 'center';
    context.fillText('ลงชื่อ ........................................................ ผู้จัดทำ', 335, 1575);
    context.fillText('ลงชื่อ ........................................................ ผู้ตรวจสอบ', 890, 1575);
    context.fillText('(........................................................)', 335, 1620);
    context.fillText('(........................................................)', 890, 1620);
    context.fillText('วันที่ ........../........../..........', 335, 1660);
    context.fillText('วันที่ ........../........../..........', 890, 1660);
  }

  context.fillStyle = '#333333';
  context.font = `22px ${regular}`;
  context.textAlign = 'left';
  context.fillText('QueueFlow', 55, 1710);
  context.textAlign = 'right';
  context.fillText(`หน้า ${pageNumber} จาก ${pageCount}`, 1185, 1710);
  return canvas;
}

export function buildPdfFromJpegPages(images) {
  const ascii = value => textEncoder.encode(value);
  const header = ascii('%PDF-1.4\n%QueueFlow\n');
  const objectCount = 2 + images.length * 3;
  const objects = new Array(objectCount + 1);
  objects[1] = ascii('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = images.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  objects[2] = ascii(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`);
  images.forEach((image, index) => {
    const pageObject = 3 + index * 3;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const content = ascii('q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n');
    objects[pageObject] = ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects[contentObject] = concatBytes([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('endstream')]);
    objects[imageObject] = concatBytes([ascii(`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, ascii('\nendstream')]);
  });
  const parts = [header];
  const offsets = new Array(objectCount + 1).fill(0);
  let offset = header.length;
  for (let index = 1; index <= objectCount; index += 1) {
    const objectBytes = concatBytes([ascii(`${index} 0 obj\n`), objects[index], ascii('\nendobj\n')]);
    offsets[index] = offset;
    parts.push(objectBytes);
    offset += objectBytes.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objectCount; index += 1) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(ascii(xref));
  return new Blob(parts, { type: 'application/pdf' });
}

export async function createPdfReportBlob({ tickets, periodLabel, startDate, endDate }) {
  await ensureFormalFonts();
  const rows = reportRows(tickets);
  const summary = reportSummary(tickets);
  const rowsPerPage = 18;
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const images = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageRows = rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
    const canvas = drawReportPage({ rows: pageRows, pageNumber: pageIndex + 1, pageCount, periodLabel, startDate, endDate, summary });
    images.push(await canvasToJpeg(canvas));
  }
  return buildPdfFromJpegPages(images);
}

export async function downloadExcelReport(options) {
  const blob = await createExcelReportBlob(options);
  downloadBlob(blob, `QueueFlow-${fileSafe(options.periodLabel)}.xlsx`);
}

export async function downloadPdfReport(options) {
  const blob = await createPdfReportBlob(options);
  downloadBlob(blob, `QueueFlow-${fileSafe(options.periodLabel)}.pdf`);
}

export function downloadCsvReport({ tickets, periodLabel, startDate, endDate }) {
  const rows = reportRows(tickets);
  const summary = reportSummary(tickets);
  const valueAsText = value => value === '-' ? '-' : `="${String(value).replaceAll('"', '""')}"`;
  const splitTimestamp = value => {
    if (!value) return ['-', '-'];
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return ['-', '-'];
    const time = new Intl.DateTimeFormat('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Bangkok',
    }).format(date);
    return [valueAsText(formatThaiDate(date)), valueAsText(time)];
  };
  const values = [
    ['รายงานสรุปการให้บริการ QueueFlow'],
    ['สถานพยาบาล', 'มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน'],
    ['ช่วงเวลา', periodLabel || '-'],
    ['ข้อมูลระหว่าง', `${formatThaiDate(startDate)} ถึง ${formatThaiDate(endDate)}`],
    ['วันที่จัดทำ', `${formatThaiDate(new Date(), true)} น.`],
    [],
    ['สรุปจำนวนคิว'],
    ['คิวทั้งหมด', summary.total, 'ผู้ป่วยทั่วไป', summary.general, 'อุบัติเหตุ', summary.emergency, 'เสร็จสิ้น', summary.completed],
    [],
    ['ลำดับ', 'หมายเลขคิว', 'ประเภท', 'สถานะ', 'จุดบริการปัจจุบัน', 'วันที่ออกบัตร', 'เวลาออกบัตร', 'วันที่เสร็จสิ้น', 'เวลาเสร็จสิ้น'],
    ...rows.map(row => {
      const [issuedDate, issuedTime] = splitTimestamp(row.issuedAt);
      const [completedDate, completedTime] = splitTimestamp(row.completedAt);
      return [row.order, row.ticketCode, row.category, row.status, row.servicePoint, issuedDate, issuedTime, completedDate, completedTime];
    }),
  ];
  const csv = values.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }), `QueueFlow-${fileSafe(periodLabel)}.csv`);
}

export function printReport({ tickets, periodLabel, startDate, endDate, format = 'PDF' }) {
  document.getElementById('queueflow-print-frame')?.remove();
  const printFrame = document.createElement('iframe');
  printFrame.id = 'queueflow-print-frame';
  printFrame.title = 'เอกสารสำหรับพิมพ์รายงาน';
  printFrame.setAttribute('aria-hidden', 'true');
  Object.assign(printFrame.style, { position: 'fixed', width: '1px', height: '1px', right: '0', bottom: '0', border: '0', visibility: 'hidden' });
  document.body.appendChild(printFrame);
  const printDocument = printFrame.contentDocument;
  if (!printDocument) {
    printFrame.remove();
    throw new Error('ไม่สามารถเตรียมเอกสารสำหรับพิมพ์ได้');
  }
  const rows = reportRows(tickets);
  const summary = reportSummary(tickets);
  const detailRows = rows.length
    ? rows.map(row => `<tr><td class="center">${row.order}</td><td class="center">${escapeHtml(row.ticketCode)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.servicePoint)}</td><td>${escapeHtml(formatThaiDate(row.issuedAt, true))}</td><td>${escapeHtml(formatThaiDate(row.completedAt, true))}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="7">ไม่มีข้อมูลคิวในช่วงเวลานี้</td></tr>';
  printFrame.addEventListener('load', async () => {
    try {
      if (printDocument.fonts?.ready) await printDocument.fonts.ready;
      const frameWindow = printFrame.contentWindow;
      if (!frameWindow) throw new Error('ไม่พบหน้าต่างสำหรับพิมพ์');
      const cleanup = () => printFrame.remove();
      frameWindow.addEventListener('afterprint', cleanup, { once: true });
      window.setTimeout(cleanup, 60000);
      frameWindow.focus();
      frameWindow.print();
    } catch (error) {
      printFrame.remove();
      console.error('Print report failed', error);
    }
  }, { once: true });
  printDocument.open();
  printDocument.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>รายงานสรุปการให้บริการ QueueFlow</title><style>
    @font-face{font-family:'TH Sarabun New';src:url('${escapeHtml(regularFontUrl)}') format('truetype');font-weight:400}
    @font-face{font-family:'TH Sarabun New';src:url('${escapeHtml(boldFontUrl)}') format('truetype');font-weight:700}
    @page{size:A4 landscape;margin:12mm 10mm}*{box-sizing:border-box}body{margin:0;color:#111;font-family:'TH Sarabun New',sans-serif;font-size:18pt;line-height:1.2}h1,h2,p{margin:0}header{text-align:center;border-bottom:1.5px solid #111;padding-bottom:7mm;margin-bottom:5mm}h1{font-size:27pt}h2{font-size:20pt}.meta{display:grid;grid-template-columns:1fr 1fr;gap:1mm 8mm;margin-bottom:4mm}.summary{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #555;margin-bottom:5mm}.summary div{padding:3mm;text-align:center;border-right:1px solid #555}.summary div:last-child{border-right:0}.summary strong{font-weight:700}table{width:100%;border-collapse:collapse;font-size:15pt}thead{display:table-header-group}th,td{border:1px solid #666;padding:2mm 2.5mm;vertical-align:middle}th{background:#e8e8e8;font-weight:700;text-align:center}tbody tr:nth-child(even){background:#f8f8f8}.center{text-align:center}.empty{text-align:center;padding:10mm}.note{margin-top:6mm;font-size:16pt}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:25mm;margin-top:12mm;text-align:center;break-inside:avoid}.signature div{margin-top:5mm}
  </style></head><body><header><h1>รายงานสรุปการให้บริการ</h1><h2>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</h2></header><section class="meta"><p><strong>ช่วงเวลา:</strong> ${escapeHtml(periodLabel || '-')}</p><p><strong>ข้อมูลระหว่าง:</strong> ${escapeHtml(formatThaiDate(startDate))} ถึง ${escapeHtml(formatThaiDate(endDate))}</p><p><strong>วันที่จัดทำ:</strong> ${escapeHtml(formatThaiDate(new Date(), true))} น.</p><p><strong>รูปแบบรายงาน:</strong> ${escapeHtml(format)}</p><p><strong>จำนวนรายการ:</strong> ${summary.total} คิว</p></section><section class="summary"><div>คิวทั้งหมด <strong>${summary.total}</strong> คิว</div><div>ผู้ป่วยทั่วไป <strong>${summary.general}</strong> คิว</div><div>อุบัติเหตุ <strong>${summary.emergency}</strong> คิว</div><div>เสร็จสิ้น <strong>${summary.completed}</strong> คิว</div></section><table><thead><tr><th>ลำดับ</th><th>หมายเลขคิว</th><th>ประเภท</th><th>สถานะ</th><th>จุดบริการปัจจุบัน</th><th>เวลาออกบัตร</th><th>เวลาเสร็จสิ้น</th></tr></thead><tbody>${detailRows}</tbody></table><p class="note">หมายเหตุ: รายงานนี้จัดทำจากข้อมูลการให้บริการที่บันทึกในระบบ QueueFlow</p><section class="signatures"><div class="signature"><div>ลงชื่อ ........................................................ ผู้จัดทำ</div><div>(........................................................)</div><div>วันที่ ........../........../..........</div></div><div class="signature"><div>ลงชื่อ ........................................................ ผู้ตรวจสอบ</div><div>(........................................................)</div><div>วันที่ ........../........../..........</div></div></section></body></html>`);
  printDocument.close();
}
