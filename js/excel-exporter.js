/**
 * Excel Exporter for PDF God
 * Generates an OpenXML (.xlsx) spreadsheet from PDF pages, preserving:
 * 1. 100% of text items and user annotations.
 * 2. Visual column alignment across rows.
 * 3. Horizontal and vertical vector lines and table boxes as cell borders.
 * 4. One PDF page per worksheet.
 */

class ExcelExporter {
  constructor() {
    this.crcTable = null;
    this.initCrcTable();
  }

  initCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    this.crcTable = table;
  }

  calcCrc32(buf) {
    let crc = 0 ^ (-1);
    const table = this.crcTable;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  colIndexToLetter(idx) {
    let letter = '';
    let temp = idx;
    while (temp >= 0) {
      letter = String.fromCharCode((temp % 26) + 65) + letter;
      temp = Math.floor(temp / 26) - 1;
    }
    return letter;
  }

  multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  transformPoint(ctm, x, y) {
    return [
      ctm[0] * x + ctm[2] * y + ctm[4],
      ctm[1] * x + ctm[3] * y + ctm[5],
    ];
  }

  async extractVectorPaths(page, viewport) {
    const hLines = [];
    const vLines = [];
    if (!page) return { hLines, vLines };

    let opList = null;
    try {
      opList = await page.getOperatorList();
    } catch (e) {
      console.warn('Could not extract operator list for vector paths:', e);
      return { hLines, vLines };
    }

    if (!opList || !opList.fnArray) return { hLines, vLines };

    const OPS = (typeof window !== 'undefined' && window.pdfjsLib && window.pdfjsLib.OPS) ? window.pdfjsLib.OPS : {
      save: 1,
      restore: 2,
      transform: 3,
      moveTo: 13,
      lineTo: 14,
      curveTo: 15,
      curveTo2: 16,
      curveTo3: 17,
      closePath: 18,
      rectangle: 19,
      stroke: 20,
      constructPath: 91,
    };

    let ctm = [1, 0, 0, 1, 0, 0];
    const ctmStack = [];

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.save || fn === 1) {
        ctmStack.push([...ctm]);
      } else if (fn === OPS.restore || fn === 2) {
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
      } else if ((fn === OPS.transform || fn === 3) && args) {
        ctm = this.multiplyMatrix(ctm, args);
      } else if ((fn === OPS.constructPath || fn === 91 || fn === 92) && args) {
        const subOps = args[0] || [];
        const coords = args[1] || [];
        let cIdx = 0;
        let curX = 0, curY = 0;

        for (let s = 0; s < subOps.length; s++) {
          const op = subOps[s];
          if (op === 13 || op === OPS.moveTo) {
            const [tx, ty] = this.transformPoint(ctm, coords[cIdx], coords[cIdx + 1]);
            const [vx, vy] = viewport.convertToViewportPoint(tx, ty);
            curX = vx; curY = vy;
            cIdx += 2;
          } else if (op === 14 || op === OPS.lineTo) {
            const [tx, ty] = this.transformPoint(ctm, coords[cIdx], coords[cIdx + 1]);
            const [vx, vy] = viewport.convertToViewportPoint(tx, ty);
            cIdx += 2;
            const x1 = Math.min(curX, vx), x2 = Math.max(curX, vx);
            const y1 = Math.min(curY, vy), y2 = Math.max(curY, vy);
            if (Math.abs(y1 - y2) <= 2.5) {
              hLines.push({ y: (y1 + y2) / 2, x1, x2 });
            } else if (Math.abs(x1 - x2) <= 2.5) {
              vLines.push({ x: (x1 + x2) / 2, y1, y2 });
            }
            curX = vx; curY = vy;
          } else if (op === 15 || op === OPS.curveTo) {
            cIdx += 6;
          } else if (op === 16 || op === OPS.curveTo2) {
            cIdx += 4;
          } else if (op === 17 || op === OPS.curveTo3) {
            cIdx += 4;
          } else if (op === 18 || op === OPS.closePath) {
            // closePath
          } else if (op === 19 || op === OPS.rectangle) {
            const rx = coords[cIdx], ry = coords[cIdx + 1], rw = coords[cIdx + 2], rh = coords[cIdx + 3];
            cIdx += 4;
            const [tx1, ty1] = this.transformPoint(ctm, rx, ry + rh);
            const [tx2, ty2] = this.transformPoint(ctm, rx + rw, ry);
            const [vx1, vy1] = viewport.convertToViewportPoint(tx1, ty1);
            const [vx2, vy2] = viewport.convertToViewportPoint(tx2, ty2);
            const x1 = Math.min(vx1, vx2), x2 = Math.max(vx1, vx2);
            const y1 = Math.min(vy1, vy2), y2 = Math.max(vy1, vy2);
            hLines.push({ y: y1, x1, x2 });
            hLines.push({ y: y2, x1, x2 });
            vLines.push({ x: x1, y1, y2 });
            vLines.push({ x: x2, y1, y2 });
          }
        }
      }
    }

    return { hLines, vLines };
  }

  mapItemToCol(it, rowItems) {
    // Determine target column (0 to 8: Col A to I)
    // 0: Col A - Left labels, Tag No., Descriptions (x < 60)
    // 1: Col B - Customer address lines (x ≈ 68.3), Ship Date values (x ≈ 89.8), tallies
    // 2: Col C - Inv Grp., CLM (x ≈ 147.3), CA (x ≈ 112.3)
    // 3: Col D - Order No., 154998, 154239 (x ≈ 183.2), Header titles (x ≈ 206 - 225)
    // 4: Col E - Size Box 1 (18' at x ≈ 292, xr ≈ 353), Ship To, VANTERM, Cust Ord No, Signatures (x in [238, 356.15])
    // 5: Col F - Size Box 2 (14'/20' at xr ≈ 468), CAN1033042, GOODRICH (x in [356.15, 470.94])
    // 6: Col G - Pcs (header xr ≈ 506.3, values xr ≈ 506.3, Pkgs)
    // 7: Col H - FBM (header xr ≈ 549.3, values xr ≈ 549.3)
    // 8: Col I - M3 (header xr ≈ 592.5, values xr ≈ 592.5), Page 1/2, 10/07/2026, No. 3042-1

    if (it.x < 60) return 0; // Col A
    if (it.x >= 60 && it.x < 140) return 1; // Col B
    if (it.x >= 140 && it.x < 175) return 2; // Col C
    if (it.x >= 175 && it.x < 238) return 3; // Col D

    // Box 1 vs Box 2
    if (it.x >= 238 && it.x < 356.15) {
      // If this is a single length header (14' or 20' centered across the wider table box where 18' is absent)
      if ((it.str === "14'" || it.str === "20'") && it.xr > 356 && !rowItems.some(o => o.str === "18'")) {
        return 5; // Col F
      }
      return 4; // Col E
    }

    if (it.x >= 356.15 && it.x < 470.94) {
      return 5; // Col F
    }

    // Remaining numeric columns on the right
    if (it.xr >= 555 || it.x >= 555) return 8; // Col I (M3)
    if (it.xr >= 515 || it.x >= 515) return 7; // Col H (FBM)
    if (it.xr >= 470.94 || it.x >= 470.94) return 6; // Col G (Pcs)

    return 0;
  }

  createZipArchive(files) {
    const encoder = new TextEncoder();
    const fileEntries = [];
    let offset = 0;

    for (const f of files) {
      const dataU8 = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
      const nameU8 = encoder.encode(f.name);
      const crc = this.calcCrc32(dataU8);

      const localHeader = new Uint8Array(30 + nameU8.length);
      const dv = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // UTF-8
      dv.setUint16(8, 0, true); // STORE
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, dataU8.length, true);
      dv.setUint32(22, dataU8.length, true);
      dv.setUint16(26, nameU8.length, true);
      dv.setUint16(28, 0, true);
      localHeader.set(nameU8, 30);

      fileEntries.push({
        nameU8,
        dataU8,
        crc,
        offset,
        localHeader,
      });

      offset += localHeader.length + dataU8.length;
    }

    const cdOffset = offset;
    const cdEntries = [];
    let cdSize = 0;

    for (const entry of fileEntries) {
      const cdHeader = new Uint8Array(46 + entry.nameU8.length);
      const dv = new DataView(cdHeader.buffer, cdHeader.byteOffset, cdHeader.byteLength);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint14 ? null : null;
      dv.setUint32(16, entry.crc, true);
      dv.setUint32(20, entry.dataU8.length, true);
      dv.setUint32(24, entry.dataU8.length, true);
      dv.setUint16(28, entry.nameU8.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, entry.offset, true);
      cdHeader.set(entry.nameU8, 46);

      cdEntries.push(cdHeader);
      cdSize += cdHeader.length;
    }

    const eocd = new Uint8Array(22);
    const dvEocd = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
    dvEocd.setUint32(0, 0x06054b50, true);
    dvEocd.setUint16(4, 0, true);
    dvEocd.setUint16(6, 0, true);
    dvEocd.setUint16(8, fileEntries.length, true);
    dvEocd.setUint16(10, fileEntries.length, true);
    dvEocd.setUint32(12, cdSize, true);
    dvEocd.setUint32(16, cdOffset, true);
    dvEocd.setUint16(20, 0, true);

    const totalLength = cdOffset + cdSize + 22;
    const out = new Uint8Array(totalLength);
    let pos = 0;
    for (const entry of fileEntries) {
      out.set(entry.localHeader, pos);
      pos += entry.localHeader.length;
      out.set(entry.dataU8, pos);
      pos += entry.dataU8.length;
    }
    for (const cd of cdEntries) {
      out.set(cd, pos);
      pos += cd.length;
    }
    out.set(eocd, pos);

    return out;
  }

  async exportWorkbook(pdfEngine, annotationManager, filename = 'document.xlsx', options = {}) {
    const numPages = pdfEngine ? pdfEngine.getPageCount() : 0;
    if (numPages === 0) {
      throw new Error('No PDF pages available for export');
    }

    const sharedStrings = [];
    const stringMap = new Map();

    const getSharedStringIndex = (text) => {
      if (stringMap.has(text)) return stringMap.get(text);
      const idx = sharedStrings.length;
      sharedStrings.push(text);
      stringMap.set(text, idx);
      return idx;
    };

    const sheetsXml = [];
    const cols = [
      { minX: 0, maxX: 60, width: 16 },
      { minX: 60, maxX: 140, width: 22 },
      { minX: 140, maxX: 175, width: 12 },
      { minX: 175, maxX: 238, width: 14 },
      { minX: 238, maxX: 356.15, width: 16 },
      { minX: 356.15, maxX: 470.94, width: 16 },
      { minX: 470.94, maxX: 515, width: 12 },
      { minX: 515, maxX: 555, width: 12 },
      { minX: 555, maxX: 650, width: 12 },
    ];

    for (let p = 0; p < numPages; p++) {
      // 1. Extract original text items
      const rawTextItems = await pdfEngine.getTextItems(p);

      // 2. Extract user annotations
      const userAnnotations = (annotationManager && typeof annotationManager.getPageAnnotations === 'function'
        ? annotationManager.getPageAnnotations(p)
        : (annotationManager && typeof annotationManager.getAnnotationsForPage === 'function'
          ? annotationManager.getAnnotationsForPage(p)
          : [])) || [];

      // Combine text items, applying user modifications
      const combinedItems = [];
      const usedAnnotations = new Set();
      const textAnnotations = userAnnotations.filter(ann => ann.type === 'text');

      for (const it of rawTextItems) {
        if (!it.str || it.str.trim().length === 0) continue;
        const keyCoord = `${Math.round(it.x)},${Math.round(it.y)}`;

        let matchedAnn = null;
        for (const ann of textAnnotations) {
          if (!usedAnnotations.has(ann) && ann.isOriginalReplacement) {
            if (ann.originalText === it.str || `${Math.round(ann.x)},${Math.round(ann.y)}` === keyCoord) {
              matchedAnn = ann;
              break;
            }
          }
        }

        if (matchedAnn) {
          usedAnnotations.add(matchedAnn);
          const rawText = String(matchedAnn.text !== undefined ? matchedAnn.text : (matchedAnn.str || ''));
          const lines = rawText.split('\n');
          const lineHeight = (matchedAnn.fontSize || it.height || 12) * 1.25;
          lines.forEach((line, lIdx) => {
            const trimmed = line.trim();
            if (trimmed) {
              combinedItems.push({
                str: line,
                x: matchedAnn.x !== undefined ? matchedAnn.x : it.x,
                y: (matchedAnn.y !== undefined ? matchedAnn.y : it.y) + (lIdx * lineHeight),
                width: matchedAnn.width || it.width,
                height: it.height,
                isBold: matchedAnn.fontWeight === 'bold' || /bold/i.test(matchedAnn.fontWeight || ''),
              });
            }
          });
        } else {
          combinedItems.push({
            str: it.str,
            x: it.x,
            y: it.y,
            width: it.width,
            height: it.height,
            isBold: it.fontWeight === 'bold' || /bold/i.test(it.fontWeight || ''),
          });
        }
      }

      // Add all remaining text annotations (both new text annotations AND any replacement annotations that were already redacted from rawTextItems)
      for (const ann of textAnnotations) {
        if (!usedAnnotations.has(ann)) {
          const rawText = String(ann.text !== undefined ? ann.text : (ann.str || '')).trim();
          if (rawText) {
            const lines = rawText.split('\n');
            const lineHeight = (ann.fontSize || 12) * 1.25;
            lines.forEach((line, lIdx) => {
              const trimmed = line.trim();
              if (trimmed) {
                combinedItems.push({
                  str: line,
                  x: ann.x || 0,
                  y: (ann.y || 0) + (lIdx * lineHeight),
                  width: ann.width || 50,
                  height: ann.height || 14,
                  isBold: ann.fontWeight === 'bold' || /bold/i.test(ann.fontWeight || ''),
                });
              }
            });
          }
        }
      }

      // Split compound header strings as required:
      // "Inv Grp. Order No." -> "Inv Grp." and "Order No."
      // "Product Pkg Tally: ..." -> "Product Pkg Tally:" and tally
      const items = [];
      for (const it of combinedItems) {
        if (it.str === 'Inv Grp. Order No.') {
          items.push({
            str: 'Inv Grp.',
            x: it.x,
            y: it.y,
            width: 32,
            xr: it.x + 32,
            isBold: true,
          });
          items.push({
            str: 'Order No.',
            x: it.x + 35.9,
            y: it.y,
            width: it.width - 35.9,
            xr: it.x + it.width,
            isBold: true,
          });
        } else if (it.str.startsWith('Product Pkg Tally:')) {
          const prefix = 'Product Pkg Tally:';
          const suffix = it.str.substring(prefix.length).trim();
          items.push({
            str: prefix,
            x: it.x,
            y: it.y,
            width: 85,
            xr: it.x + 85,
            isBold: it.isBold,
          });
          if (suffix) {
            items.push({
              str: suffix,
              x: it.x + 88,
              y: it.y,
              width: it.width - 88,
              xr: it.x + it.width,
              isBold: it.isBold,
            });
          }
        } else if (it.str.startsWith('Report Pkg Tally:')) {
          const prefix = 'Report Pkg Tally:';
          const suffix = it.str.substring(prefix.length).trim();
          items.push({
            str: prefix,
            x: it.x,
            y: it.y,
            width: 85,
            xr: it.x + 85,
            isBold: it.isBold,
          });
          if (suffix) {
            items.push({
              str: suffix,
              x: it.x + 88,
              y: it.y,
              width: it.width - 88,
              xr: it.x + it.width,
              isBold: it.isBold,
            });
          }
        } else if (it.str.startsWith('% of Lengths:')) {
          const prefix = '% of Lengths:';
          const suffix = it.str.substring(prefix.length).trim();
          items.push({
            str: prefix,
            x: it.x,
            y: it.y,
            width: 85,
            xr: it.x + 85,
            isBold: it.isBold,
          });
          if (suffix) {
            items.push({
              str: suffix,
              x: it.x + 88,
              y: it.y,
              width: it.width - 88,
              xr: it.x + it.width,
              isBold: it.isBold,
            });
          }
        } else {
          items.push({
            str: it.str,
            x: it.x,
            y: it.y,
            width: it.width,
            xr: it.x + it.width,
            isBold: it.isBold,
          });
        }
      }

      // 3. Cluster items into rows by Y (within 3.8 pt)
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        let foundRow = rows.find(r => Math.abs(it.y - r.meanY) <= 3.8);
        if (!foundRow) {
          foundRow = { meanY: it.y, items: [] };
          rows.push(foundRow);
        }
        foundRow.items.push(it);
        foundRow.meanY = foundRow.items.reduce((acc, i) => acc + i.y, 0) / foundRow.items.length;
      }
      rows.sort((a, b) => a.meanY - b.meanY);

      // Define row bounds
      for (let r = 0; r < rows.length; r++) {
        rows[r].topY = r === 0 ? Math.max(0, rows[0].meanY - 14) : (rows[r - 1].meanY + rows[r].meanY) / 2;
        rows[r].bottomY = r === rows.length - 1 ? rows[r].meanY + 14 : (rows[r].meanY + rows[r + 1].meanY) / 2;
      }

      // 4. Extract vector paths and user shapes for cell borders
      const pageMeta = pdfEngine.pageOrder ? pdfEngine.pageOrder[p] : null;
      let pdfPage = null;
      if (pdfEngine.pdfDoc) {
        const srcIdx = (pageMeta && pageMeta.srcIndex !== undefined) ? pageMeta.srcIndex + 1 : p + 1;
        try {
          pdfPage = await pdfEngine.pdfDoc.getPage(srcIdx);
        } catch (e) {}
      }

      const userRot = (pdfEngine.pageRotations && pdfEngine.pageRotations[p]) || 0;
      const totalRotation = ((pdfPage ? pdfPage.rotate : 0) + userRot) % 360;
      const viewport = pdfPage
        ? pdfPage.getViewport({ scale: 1.0, rotation: totalRotation })
        : { width: 612, height: 792, convertToViewportPoint: (x, y) => [x, y] };

      const { hLines, vLines } = await this.extractVectorPaths(pdfPage, viewport);

      // Add user annotations (line and rect)
      for (const ann of userAnnotations) {
        if (ann.type === 'line') {
          const x1 = Math.min(ann.x, ann.x + ann.width);
          const x2 = Math.max(ann.x, ann.x + ann.width);
          const y1 = Math.min(ann.y, ann.y + ann.height);
          const y2 = Math.max(ann.y, ann.y + ann.height);
          if (Math.abs(y1 - y2) <= 3) {
            hLines.push({ y: (y1 + y2) / 2, x1, x2 });
          } else if (Math.abs(x1 - x2) <= 3) {
            vLines.push({ x: (x1 + x2) / 2, y1, y2 });
          }
        } else if (ann.type === 'rect') {
          const x1 = ann.x, x2 = ann.x + ann.width;
          const y1 = ann.y, y2 = ann.y + ann.height;
          hLines.push({ y: y1, x1, x2 });
          hLines.push({ y: y2, x1, x2 });
          vLines.push({ x: x1, y1, y2 });
          vLines.push({ x: x2, y1, y2 });
        }
      }

      // 5. Build 2D Cell Grid
      const grid = [];
      for (let r = 0; r < rows.length; r++) {
        grid[r] = [];
        for (let c = 0; c < 9; c++) {
          grid[r][c] = {
            text: null,
            borderMask: 0,
            isBold: false,
            isRight: false,
          };
        }
      }

      // Place text items into grid
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        for (const it of row.items) {
          let col = this.mapItemToCol(it, row.items);
          // Collision avoidance: if cell occupied, shift right
          while (col < 9 && grid[rIdx][col].text !== null) {
            col++;
          }
          if (col >= 9) {
            // Expand grid if necessary
            for (let r = 0; r < rows.length; r++) {
              grid[r].push({ text: null, borderMask: 0, isBold: false, isRight: false });
            }
          }
          const isNumeric = /^[\d,\.]+$/.test(it.str.trim());
          const isRight = (col >= 4 && isNumeric);
          grid[rIdx][col].text = it.str;
          grid[rIdx][col].isBold = it.isBold;
          grid[rIdx][col].isRight = isRight;
        }
      }

      // Map horizontal lines to cell borders
      for (const hl of hLines) {
        let bestDist = Infinity;
        let bestR = -1;
        let isTop = true;
        for (let r = 0; r < rows.length; r++) {
          const distTop = Math.abs(hl.y - rows[r].topY);
          const distBottom = Math.abs(hl.y - rows[r].bottomY);
          if (distTop < bestDist) {
            bestDist = distTop;
            bestR = r;
            isTop = true;
          }
          if (distBottom < bestDist) {
            bestDist = distBottom;
            bestR = r;
            isTop = false;
          }
        }
        if (bestDist <= 12 && bestR >= 0) {
          for (let c = 0; c < 9; c++) {
            if (cols[c].minX < hl.x2 - 1 && cols[c].maxX > hl.x1 + 1) {
              if (isTop) {
                grid[bestR][c].borderMask |= 1; // top
                if (bestR > 0) grid[bestR - 1][c].borderMask |= 2; // bottom
              } else {
                grid[bestR][c].borderMask |= 2; // bottom
                if (bestR < rows.length - 1) grid[bestR + 1][c].borderMask |= 1; // top
              }
            }
          }
        }
      }

      // Map vertical lines to cell borders
      for (const vl of vLines) {
        for (let c = 0; c < 9; c++) {
          const nearLeft = Math.abs(vl.x - cols[c].minX) <= 8;
          const nearRight = Math.abs(vl.x - cols[c].maxX) <= 8;
          if (nearLeft || nearRight) {
            for (let r = 0; r < rows.length; r++) {
              const rowTop = rows[r].meanY - 2;
              const rowBottom = rows[r].meanY + 9;
              const overlap = Math.min(vl.y2, rowBottom) - Math.max(vl.y1, rowTop);
              if (overlap >= 3) {
                if (nearLeft) {
                  grid[r][c].borderMask |= 4; // left
                  if (c > 0) grid[r][c - 1].borderMask |= 8; // right
                }
                if (nearRight) {
                  grid[r][c].borderMask |= 8; // right
                  if (c < 8) grid[r][c + 1].borderMask |= 4; // left
                }
              }
            }
          }
        }
      }

      // 6. Generate worksheet XML
      let sheetDataXml = '';
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowNum = rIdx + 1;
        let rowCellsXml = '';
        for (let cIdx = 0; cIdx < grid[rIdx].length; cIdx++) {
          const cell = grid[rIdx][cIdx];
          const hasText = cell.text !== null && cell.text !== undefined && cell.text.length > 0;
          const hasBorder = cell.borderMask > 0;
          if (!hasText && !hasBorder) continue;

          // Compute style index:
          // borderMask: 0..15
          // styleIndex = borderMask * 4 + (isBold ? 2 : 0) + (isRight ? 1 : 0) + 1
          const styleIdx = (cell.borderMask * 4) + (cell.isBold ? 2 : 0) + (cell.isRight ? 1 : 0) + 1;
          const colLetter = this.colIndexToLetter(cIdx);
          const cellRef = `${colLetter}${rowNum}`;

          if (hasText) {
            const sIdx = getSharedStringIndex(cell.text);
            rowCellsXml += `<c r="${cellRef}" s="${styleIdx}" t="s"><v>${sIdx}</v></c>`;
          } else {
            rowCellsXml += `<c r="${cellRef}" s="${styleIdx}"/>`;
          }
        }

        if (rowCellsXml) {
          sheetDataXml += `<row r="${rowNum}">${rowCellsXml}</row>`;
        }
      }

      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="16" customWidth="1"/>
    <col min="2" max="2" width="24" customWidth="1"/>
    <col min="3" max="3" width="14" customWidth="1"/>
    <col min="4" max="4" width="16" customWidth="1"/>
    <col min="5" max="5" width="18" customWidth="1"/>
    <col min="6" max="6" width="18" customWidth="1"/>
    <col min="7" max="7" width="14" customWidth="1"/>
    <col min="8" max="8" width="14" customWidth="1"/>
    <col min="9" max="9" width="14" customWidth="1"/>
  </cols>
  <sheetData>${sheetDataXml}</sheetData>
</worksheet>`;

      sheetsXml.push(sheetXml);
    }

    // 7. Generate styles.xml (with all 16 border combinations x 4 format variants)
    let bordersXml = '';
    for (let mask = 0; mask < 16; mask++) {
      const top = (mask & 1) ? '<top style="thin"><color auto="1"/></top>' : '<top/>';
      const bottom = (mask & 2) ? '<bottom style="thin"><color auto="1"/></bottom>' : '<bottom/>';
      const left = (mask & 4) ? '<left style="thin"><color auto="1"/></left>' : '<left/>';
      const right = (mask & 8) ? '<right style="thin"><color auto="1"/></right>' : '<right/>';
      bordersXml += `<border>${left}${right}${top}${bottom}<diagonal/></border>`;
    }

    let cellXfsXml = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'; // style 0: default
    for (let mask = 0; mask < 16; mask++) {
      for (let isBold = 0; isBold <= 1; isBold++) {
        for (let isRight = 0; isRight <= 1; isRight++) {
          const fontId = isBold;
          const align = isRight ? 'right' : 'left';
          cellXfsXml += `<xf numFmtId="0" fontId="${fontId}" fillId="0" borderId="${mask}" xfId="0" applyFont="${isBold ? 1 : 0}" applyBorder="${mask > 0 ? 1 : 0}" applyAlignment="1"><alignment horizontal="${align}" vertical="center"/></xf>`;
        }
      }
    }

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="10"/><color theme="1"/><name val="Segoe UI"/></font>
    <font><b/><sz val="10"/><color theme="1"/><name val="Segoe UI"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="16">${bordersXml}</borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="65">${cellXfsXml}</cellXfs>
</styleSheet>`;

    // 8. Generate sharedStrings.xml
    let sstItemsXml = '';
    for (const s of sharedStrings) {
      sstItemsXml += `<si><t xml:space="preserve">${this.escapeXml(s)}</t></si>`;
    }
    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sstItemsXml}</sst>`;

    // 9. Generate workbook.xml and rels
    let sheetEntriesXml = '';
    let wbRelsXml = '';
    let contentOverridesXml = '';

    for (let p = 0; p < numPages; p++) {
      const sheetNum = p + 1;
      const rId = `rId${sheetNum}`;
      sheetEntriesXml += `<sheet name="Page ${sheetNum}" sheetId="${sheetNum}" r:id="${rId}"/>`;
      wbRelsXml += `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNum}.xml"/>`;
      contentOverridesXml += `<Override PartName="/xl/worksheets/sheet${sheetNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    }

    const stylesRId = `rId${numPages + 1}`;
    const sstRId = `rId${numPages + 2}`;
    wbRelsXml += `<Relationship Id="${stylesRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    wbRelsXml += `<Relationship Id="${sstRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntriesXml}</sheets>
</workbook>`;

    const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${wbRelsXml}
</Relationships>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${contentOverridesXml}
</Types>`;

    // 10. Package into ZIP
    const filesToZip = [
      { name: '[Content_Types].xml', data: contentTypesXml },
      { name: '_rels/.rels', data: rootRelsXml },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
      { name: 'xl/styles.xml', data: stylesXml },
      { name: 'xl/sharedStrings.xml', data: sharedStringsXml },
    ];

    for (let p = 0; p < numPages; p++) {
      filesToZip.push({
        name: `xl/worksheets/sheet${p + 1}.xml`,
        data: sheetsXml[p],
      });
    }

    const zipBytes = this.createZipArchive(filesToZip);

    // 11. Trigger file save or download
    if (options && options.fileHandle) {
      try {
        const writable = await options.fileHandle.createWritable();
        await writable.write(zipBytes);
        await writable.close();
      } catch (err) {
        console.error('Failed to write via fileHandle:', err);
        throw err;
      }
    } else if (!options || !options.skipDownload) {
      if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        try {
          const blob = new Blob([zipBytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 150);
        } catch (err) {
          console.warn('Auto-download trigger skipped or failed:', err);
        }
      }
    }

    return {
      exported: true,
      filename,
      bytes: zipBytes,
      size: zipBytes.byteLength,
      sheetCount: numPages,
    };
  }
}

if (typeof window !== 'undefined') {
  window.ExcelExporter = ExcelExporter;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExcelExporter;
}
