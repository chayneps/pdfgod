/**
 * PDF Engine
 * Handles PDF rendering via PDF.js, page manipulation, and PDF generation via PDF-Lib.
 */

class PDFEngine {
  constructor() {
    this.pdfDoc = null;             // PDF.js document proxy
    this.originalPdfBytes = null;   // Uint8Array of the loaded PDF
    this.activePdfBytes = null;     // Uint8Array of current in-memory PDF with real text redactions/edits
    this.redactionHistory = [];     // Undo stack of in-memory PDF byte snapshots
    this.filename = 'document.pdf';
    this.numPages = 0;
    this.pageSizes = [];            // [{ width, height, originalRotation }] in unscaled points
    this.pageRotations = [];        // user-applied rotations per page (e.g. 0, 90, 180, 270)
    this.pageOrder = [];            // array of page metadata: [{ type: 'original', srcIndex: 0 }, { type: 'blank', width, height }]
    this.pageRenderTasks = new Map(); // cancellation trackers for active renders

    // Configure PDF.js worker
    if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      const workerCodeEl = document.getElementById('pdf-worker-code');
      if (workerCodeEl && workerCodeEl.textContent.trim().length > 0) {
        try {
          const blob = new Blob([workerCodeEl.textContent], { type: 'application/javascript' });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
        } catch (e) {
          console.warn('Could not create worker blob, fallback to main thread:', e);
        }
      } else {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
      }
    }
  }

  // Load PDF from Uint8Array or ArrayBuffer
  async loadPDF(bytes, filename = 'document.pdf') {
    this.filename = filename;
    const uint8 = new Uint8Array(bytes);
    this.originalPdfBytes = new Uint8Array(uint8.length);
    this.originalPdfBytes.set(uint8);
    this.activePdfBytes = new Uint8Array(uint8.length);
    this.activePdfBytes.set(uint8);
    this.redactionHistory = [];

    // Cancel any ongoing renders
    this.pageRenderTasks.forEach(task => {
      try { task.cancel(); } catch (e) {}
    });
    this.pageRenderTasks.clear();

    // Create a clone for the PDF.js worker so originalPdfBytes is not detached
    const workerBytes = new Uint8Array(this.originalPdfBytes.length);
    workerBytes.set(this.originalPdfBytes);

    const loadingTask = window.pdfjsLib.getDocument({
      data: workerBytes,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    });

    this.pdfDoc = await loadingTask.promise;
    this.numPages = this.pdfDoc.numPages;

    // Load initial page metrics
    this.pageSizes = [];
    this.pageRotations = [];
    this.pageOrder = [];

    for (let i = 1; i <= this.numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      this.pageSizes.push({
        width: viewport.width,
        height: viewport.height,
        originalRotation: page.rotate || 0,
      });
      this.pageRotations.push(0);
      this.pageOrder.push({
        type: 'original',
        srcIndex: i - 1,
        width: viewport.width,
        height: viewport.height,
      });
    }

    return {
      numPages: this.pageOrder.length,
      filename: this.filename,
    };
  }

  // Set active PDF bytes and reload PDF.js document proxy
  async setPdfBytes(bytes) {
    if (!bytes) return false;
    this.activePdfBytes = new Uint8Array(bytes);
    const workerBytes = new Uint8Array(this.activePdfBytes.length);
    workerBytes.set(this.activePdfBytes);
    this.pdfDoc = await window.pdfjsLib.getDocument({
      data: workerBytes,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }).promise;
    return true;
  }

  // Get total page count
  getPageCount() {
    return this.pageOrder.length;
  }

  // Get effective page dimensions at 1.0 scale with user rotation
  getPageSize(displayPageIndex) {
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta) return { width: 595.28, height: 841.89 };

    const userRot = this.pageRotations[displayPageIndex] || 0;
    const isRotated90or270 = (userRot % 180 !== 0);

    return {
      width: isRotated90or270 ? pageMeta.height : pageMeta.width,
      height: isRotated90or270 ? pageMeta.width : pageMeta.height,
      userRotation: userRot,
    };
  }

  // Extract original text items from page for "Edit Existing Text" mode
  async getTextItems(displayPageIndex) {
    if (!this.pdfDoc) return [];
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta || pageMeta.type === 'blank') return [];

    try {
      const page = await this.pdfDoc.getPage(pageMeta.srcIndex + 1);

      // Ensure operator list is parsed so font dictionaries in page.commonObjs are populated
      let opList = null;
      try {
        opList = await page.getOperatorList();
      } catch (e) {}

      // Correlate operator list to extract exact text colors (RGB and Grayscale)
      let curFillColor = '#000000';
      const textColorsAtMatrices = new Map();
      if (opList && opList.fnArray && window.pdfjsLib) {
        for (let i = 0; i < opList.fnArray.length; i++) {
          const fn = opList.fnArray[i];
          const args = opList.argsArray[i];
          if ((fn === window.pdfjsLib.OPS.setFillRGBColor || fn === 26) && args) {
            const r = args[0] !== undefined ? args[0] : (args.r || 0);
            const g = args[1] !== undefined ? args[1] : (args.g || 0);
            const b = args[2] !== undefined ? args[2] : (args.b || 0);
            curFillColor = '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
          } else if ((fn === window.pdfjsLib.OPS.setFillGray || fn === 24) && args) {
            const v = Math.max(0, Math.min(255, Math.round((args[0] !== undefined ? args[0] : 0) * 255)));
            curFillColor = '#' + [v, v, v].map(x => x.toString(16).padStart(2, '0')).join('');
          } else if ((fn === window.pdfjsLib.OPS.setTextMatrix || fn === 40) && args) {
            const tx = Math.round(args[4]);
            const ty = Math.round(args[5]);
            textColorsAtMatrices.set(`${tx},${ty}`, curFillColor);
          }
        }
      }

      const textContent = await page.getTextContent();
      const userRot = this.pageRotations[displayPageIndex] || 0;
      const totalRotation = (page.rotate + userRot) % 360;
      const viewport = page.getViewport({ scale: 1.0, rotation: totalRotation });

      // Resolve fonts asynchronously from page.commonObjs
      const fontCache = {};
      const fontPromises = [];

      if (textContent.styles) {
        for (const fontId of Object.keys(textContent.styles)) {
          const style = textContent.styles[fontId] || {};
          let fontInfo = {
            family: 'Helvetica',
            bold: false,
            italic: false,
            ascent: style.ascent || 0.75,
            descent: style.descent || -0.22,
          };

          if (page.commonObjs && page.commonObjs.has(fontId)) {
            fontPromises.push(new Promise((resolve) => {
              page.commonObjs.get(fontId, (font) => {
                if (font) {
                  const name = (font.name || font.loadedName || '').toLowerCase();
                  const isBold = !!(font.bold || font.black || /bold|black|heavy|medium|w[7-9]|demi/i.test(name));
                  const isItalic = !!(font.italic || /italic|oblique/i.test(name));

                  let family = 'Helvetica';
                  if (/times|roman|minion|georgia|serif/i.test(name) || font.fallbackName === 'serif') {
                    family = 'Times New Roman';
                  } else if (/courier|mono|consolas|menlo/i.test(name) || font.fallbackName === 'monospace') {
                    family = 'Courier New';
                  } else if (/arial/i.test(name)) {
                    family = 'Arial';
                  }

                  fontInfo.family = family;
                  fontInfo.bold = isBold;
                  fontInfo.italic = isItalic;
                  if (font.ascent) fontInfo.ascent = font.ascent;
                  if (font.descent) fontInfo.descent = font.descent;
                }
                resolve();
              });
            }));
          } else {
            const raw = (style.fontFamily || fontId || '').toLowerCase();
            fontInfo.bold = /bold|black|heavy|medium|w[7-9]|demi/i.test(raw);
            fontInfo.italic = /italic|oblique/i.test(raw);
            if (/times|roman|serif/i.test(raw)) fontInfo.family = 'Times New Roman';
            else if (/courier|mono/i.test(raw)) fontInfo.family = 'Courier New';
          }

          fontCache[fontId] = fontInfo;
        }
      }

      await Promise.all(fontPromises);

      const items = [];
      for (const item of textContent.items) {
        if (!item.str || item.str.trim().length === 0) continue;

        const tx = item.transform; // [scaleX, skewY, skewX, scaleY, x, y]
        const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) || 12;

        // Viewport conversion gives exact pixel location on unscaled page
        const [ptX, ptY] = viewport.convertToViewportPoint(tx[4], tx[5]);
        const font = fontCache[item.fontName] || {
          family: 'Helvetica',
          bold: false,
          italic: false,
          ascent: 0.75,
          descent: -0.22,
        };

        const ascent = Math.min(1.0, Math.max(0.65, font.ascent || 0.75));
        const descent = Math.min(0, Math.max(-0.35, font.descent || -0.22));

        // Top of line from baseline ptY (aligns browser textarea line-height 1.15 quantized pixel ascent with PDF canvas baseline)
        const lineTop = Math.max(0, ptY - Math.floor(fontSize * 0.89));
        const lineHeight = (ascent - descent) * fontSize + 2;

        // Correlate color by transform matrix
        const rawTx = tx[4];
        const rawTy = tx[5];
        const roundTx = Math.round(rawTx);
        const roundTy = Math.round(rawTy);
        let fontColor = textColorsAtMatrices.get(`${roundTx},${roundTy}`);
        if (!fontColor) {
          for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
              const c = textColorsAtMatrices.get(`${roundTx + dx},${roundTy + dy}`);
              if (c) { fontColor = c; break; }
            }
            if (fontColor) break;
          }
        }
        if (!fontColor) fontColor = '#000000';

        items.push({
          str: item.str,
          x: +(ptX.toFixed(2)),
          y: +(lineTop.toFixed(2)),
          baselineY: +(ptY.toFixed(2)),
          width: Math.round(item.width || (item.str.length * fontSize * 0.55)),
          height: Math.round(lineHeight),
          fontSize: +(fontSize.toFixed(2)),
          fontFamily: font.family,
          fontWeight: font.bold ? 'bold' : 'normal',
          fontStyle: font.italic ? 'italic' : 'normal',
          fontColor: fontColor,
          fontName: item.fontName,
          rawTx: rawTx,
          rawTy: rawTy,
        });
      }

      return items;
    } catch (e) {
      console.warn('Could not extract text content:', e);
      return [];
    }
  }

  // Decompress Flate stream via native DecompressionStream
  async decompressFlate(u8) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(u8);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const res = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        res.set(c, pos);
        pos += c.length;
      }
      return res;
    }
    throw new Error('DecompressionStream not supported');
  }

  // Compress Flate stream via native CompressionStream
  async compressFlate(u8) {
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('deflate');
      const writer = cs.writable.getWriter();
      writer.write(u8);
      writer.close();
      const reader = cs.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const res = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        res.set(c, pos);
        pos += c.length;
      }
      return res;
    }
    throw new Error('CompressionStream not supported');
  }

  // Helper to convert string to hex for PDF operator matching
  stringToHex(str) {
    let hex = '';
    for (let i = 0; i < str.length; i++) {
      hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
  }

  escapePdfLiteral(str) {
    return str.replace(/[\\()]/g, '\\$&');
  }

  latin1ToBytes(str) {
    const u8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      u8[i] = str.charCodeAt(i) & 0xff;
    }
    return u8;
  }

  // Blank out target text in decompressed content stream string at its exact coordinates
  redactTextFromStreamString(streamText, targetStr, rawTx = null, rawTy = null) {
    if (!targetStr) return streamText;
    const normTarget = targetStr.replace(/\s+/g, ' ').trim();
    if (!normTarget) return streamText;

    // Scan stream to track text position (Td, TD, Tm, T*, TL, Ts) and collect string tokens
    const tokenRegex = /\b(BT|ET)\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(Td|TD)\b|(-?\d+(?:\.\d+)?)\s+TL\b|\b(T\*)\b|(-?\d+(?:\.\d+)?)\s+Ts\b|\((?:[^\\()]|\\.)*\)|<([0-9a-fA-F]+)>/g;

    let curX = 0;
    let curY = 0;
    let scaleX = 1;
    let scaleY = 1;
    let leading = 0;
    let textRise = 0;

    const tokens = [];
    let m;
    while ((m = tokenRegex.exec(streamText)) !== null) {
      const full = m[0];
      if (m[1] === 'BT') {
        curX = 0;
        curY = 0;
        scaleX = 1;
        scaleY = 1;
      } else if (m[1] === 'ET') {
        // End text object
      } else if (m[2] !== undefined) {
        // Tm: a b c d e f Tm
        const a = parseFloat(m[2]);
        const b = parseFloat(m[3]);
        const c = parseFloat(m[4]);
        const d = parseFloat(m[5]);
        const e = parseFloat(m[6]);
        const f = parseFloat(m[7]);
        scaleX = Math.hypot(a, b) || 1;
        scaleY = Math.hypot(c, d) || 1;
        curX = e;
        curY = f;
      } else if (m[8] !== undefined) {
        // Td or TD: tx ty Td/TD
        const dx = parseFloat(m[8]);
        const dy = parseFloat(m[9]);
        if (m[10] === 'TD') {
          leading = -dy;
        }
        curX += dx * scaleX;
        curY += dy * scaleY;
      } else if (m[11] !== undefined) {
        // TL
        leading = parseFloat(m[11]);
      } else if (m[12] !== undefined) {
        // T*
        curY -= leading * scaleY;
      } else if (m[13] !== undefined) {
        // Ts
        textRise = parseFloat(m[13]);
      } else if (full.startsWith('(')) {
        const rawInside = full.slice(1, -1);
        const decoded = rawInside.replace(/\\([\\()])/g, '$1');
        const norm = decoded.replace(/\s+/g, ' ').trim();
        tokens.push({
          start: m.index,
          end: m.index + full.length,
          rawMatch: full,
          isHex: false,
          decoded,
          norm,
          x: curX,
          rawY: curY,
          effY: curY + textRise * scaleY,
        });
      } else if (full.startsWith('<') && m[14] !== undefined) {
        const hexChars = m[14];
        let decoded = '';
        for (let i = 0; i < hexChars.length; i += 2) {
          decoded += String.fromCharCode(parseInt(hexChars.substring(i, i + 2), 16));
        }
        const norm = decoded.replace(/\s+/g, ' ').trim();
        tokens.push({
          start: m.index,
          end: m.index + full.length,
          rawMatch: full,
          isHex: true,
          decoded,
          norm,
          x: curX,
          rawY: curY,
          effY: curY + textRise * scaleY,
        });
      }
    }

    const replacements = [];
    const hasCoords = (rawTx !== null && rawTx !== undefined && rawTy !== null && rawTy !== undefined);

    if (hasCoords) {
      const getYDiff = (tok) => Math.min(Math.abs(tok.effY - rawTy), Math.abs(tok.rawY - rawTy));
      const sameLineTokens = tokens.filter(tok => tok.norm.length > 0 && getYDiff(tok) <= 3.5);

      // Priority 1: Exact string match on the same line closest to rawTx
      const exactOnLine = sameLineTokens.filter(tok => tok.norm === normTarget);
      if (exactOnLine.length > 0) {
        exactOnLine.sort((a, b) => Math.abs(a.x - rawTx) - Math.abs(b.x - rawTx));
        const best = exactOnLine[0];
        replacements.push({
          start: best.start,
          end: best.end,
          replacement: best.isHex ? '<>' : '()',
        });
      }

      // Priority 2: Adjacent tokens on the same line that PDF.js merged into targetStr (e.g. "Inv Grp." + "Order No.")
      if (replacements.length === 0 && sameLineTokens.length > 1) {
        const sortedLine = [...sameLineTokens].sort((a, b) => a.x - b.x);
        for (let i = 0; i < sortedLine.length; i++) {
          if (Math.abs(sortedLine[i].x - rawTx) > 20) continue;
          let combined = '';
          const group = [];
          for (let j = i; j < sortedLine.length; j++) {
            combined = combined ? (combined + ' ' + sortedLine[j].norm) : sortedLine[j].norm;
            group.push(sortedLine[j]);
            if (combined === normTarget) {
              for (const g of group) {
                replacements.push({
                  start: g.start,
                  end: g.end,
                  replacement: g.isHex ? '<>' : '()',
                });
              }
              break;
            }
            if (combined.length >= normTarget.length) break;
          }
          if (replacements.length > 0) break;
        }
      }

      // Priority 3: Single token on the same line that PDF.js split into multiple items (e.g. "(V0R 1K5   CA)")
      if (replacements.length === 0) {
        const containerCandidates = sameLineTokens.filter(tok => tok.norm.includes(normTarget) && tok.x <= rawTx + 15);
        if (containerCandidates.length > 0) {
          containerCandidates.sort((a, b) => Math.abs(a.x - rawTx) - Math.abs(b.x - rawTx));
          const targetTok = containerCandidates[0];
          if (!targetTok.isHex) {
            const escapedTargetPattern = normTarget
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\s+/g, '\\s+');
            const subRegex = new RegExp(escapedTargetPattern);
            const matchSub = subRegex.exec(targetTok.decoded);
            if (matchSub) {
              const before = targetTok.decoded.slice(0, matchSub.index);
              const matchedStr = matchSub[0];
              const after = targetTok.decoded.slice(matchSub.index + matchedStr.length);
              const newDecoded = after.trim().length === 0
                ? before
                : (before + matchedStr.replace(/\S/g, '  ') + after);
              replacements.push({
                start: targetTok.start,
                end: targetTok.end,
                replacement: `(${this.escapePdfLiteral(newDecoded)})`,
              });
            }
          } else {
            replacements.push({
              start: targetTok.start,
              end: targetTok.end,
              replacement: '<>',
            });
          }
        }
      }
    }

    // Fallback: only match EXACT norm === normTarget (never cross-line substring .includes()!)
    if (replacements.length === 0) {
      const exactMatches = tokens.filter(tok => tok.norm === normTarget);
      if (exactMatches.length > 0) {
        if (hasCoords) {
          exactMatches.sort((a, b) => {
            const distA = Math.hypot(a.x - rawTx, a.effY - rawTy);
            const distB = Math.hypot(b.x - rawTx, b.effY - rawTy);
            return distA - distB;
          });
          const best = exactMatches[0];
          replacements.push({
            start: best.start,
            end: best.end,
            replacement: best.isHex ? '<>' : '()',
          });
        } else {
          for (const ex of exactMatches) {
            replacements.push({
              start: ex.start,
              end: ex.end,
              replacement: ex.isHex ? '<>' : '()',
            });
          }
        }
      }
    }

    if (replacements.length === 0) return streamText;

    replacements.sort((a, b) => b.start - a.start);
    let modified = streamText;
    for (const r of replacements) {
      modified = modified.slice(0, r.start) + r.replacement + modified.slice(r.end);
    }
    return modified;
  }

  // Physically remove/blank out original text from the PDF content stream
  async redactTextFromPage(displayPageIndex, targetStr, rawTx = null, rawTy = null) {
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta || pageMeta.type === 'blank') return false;

    const PDFLib = window.PDFLib;
    if (!PDFLib) return false;

    try {
      const currentBytes = this.activePdfBytes || this.originalPdfBytes;
      if (!currentBytes) return false;

      // Save to undo stack
      if (!this.redactionHistory) this.redactionHistory = [];
      this.redactionHistory.push(new Uint8Array(currentBytes));
      if (this.redactionHistory.length > 25) this.redactionHistory.shift();

      const pdfDoc = await PDFLib.PDFDocument.load(currentBytes);
      const srcPage = pdfDoc.getPages()[pageMeta.srcIndex];
      if (!srcPage) return false;

      const contents = srcPage.node.normalizedEntries().Contents;
      if (!contents) return false;

      const arr = contents.asArray ? contents.asArray() : [contents];
      let redactedAny = false;

      for (let i = 0; i < arr.length; i++) {
        const stream = pdfDoc.context.lookup(arr[i]);
        const rawBytes = stream ? (stream.contents || (stream.getContents ? stream.getContents() : null)) : null;
        if (!stream || !rawBytes) continue;

        const filter = stream.dict.get(PDFLib.PDFName.of('Filter'));
        const isFlate = filter && (
          filter.toString() === '/FlateDecode' || 
          (filter.asArray && filter.asArray().some(f => f.toString() === '/FlateDecode'))
        );

        let streamText = '';
        if (isFlate) {
          try {
            const unzipped = await this.decompressFlate(rawBytes);
            streamText = new TextDecoder('latin1').decode(unzipped);
          } catch (e) {
            console.warn('Could not decompress stream:', e);
            continue;
          }
        } else {
          streamText = new TextDecoder('latin1').decode(rawBytes);
        }

        const modifiedText = this.redactTextFromStreamString(streamText, targetStr, rawTx, rawTy);
        if (modifiedText !== streamText) {
          redactedAny = true;
          const modifiedBytes = this.latin1ToBytes(modifiedText);
          if (isFlate) {
            const rezipped = await this.compressFlate(modifiedBytes);
            stream.contents = rezipped;
            if (stream.getContents) stream.getContents = () => rezipped;
            stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(rezipped.length));
          } else {
            stream.contents = modifiedBytes;
            if (stream.getContents) stream.getContents = () => modifiedBytes;
            stream.dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(modifiedBytes.length));
          }
        }
      }

      if (redactedAny) {
        const newPdfBytes = await pdfDoc.save();
        this.activePdfBytes = new Uint8Array(newPdfBytes);

        // Reload PDF.js document proxy so canvas rendering and text extraction reflect the updated PDF
        const workerBytes = new Uint8Array(this.activePdfBytes.length);
        workerBytes.set(this.activePdfBytes);

        this.pdfDoc = await window.pdfjsLib.getDocument({
          data: workerBytes,
          cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
          cMapPacked: true,
        }).promise;

        return true;
      }
      return false;
    } catch (e) {
      console.warn('Error during redactTextFromPage:', e);
      return false;
    }
  }

  // Restore previous PDF stream state on undo
  async undoLastRedaction(displayPageIndex) {
    if (!this.redactionHistory || this.redactionHistory.length === 0) return false;
    const prevBytes = this.redactionHistory.pop();
    this.activePdfBytes = prevBytes;

    const workerBytes = new Uint8Array(this.activePdfBytes.length);
    workerBytes.set(this.activePdfBytes);

    this.pdfDoc = await window.pdfjsLib.getDocument({
      data: workerBytes,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }).promise;

    return true;
  }

  // Render a single page to a canvas
  async renderPage(displayPageIndex, canvas, zoom = 1.0) {
    if (!this.pdfDoc) return;
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta) return;

    // Cancel previous render on this canvas if active
    if (this.pageRenderTasks.has(canvas)) {
      try {
        this.pageRenderTasks.get(canvas).cancel();
      } catch (e) {}
      this.pageRenderTasks.delete(canvas);
    }

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const userRot = this.pageRotations[displayPageIndex] || 0;

    // Handle blank page
    if (pageMeta.type === 'blank') {
      const pageSize = this.getPageSize(displayPageIndex);
      const viewportWidth = pageSize.width * zoom;
      const viewportHeight = pageSize.height * zoom;

      canvas.width = Math.floor(viewportWidth * dpr);
      canvas.height = Math.floor(viewportHeight * dpr);
      canvas.style.width = `${Math.floor(viewportWidth)}px`;
      canvas.style.height = `${Math.floor(viewportHeight)}px`;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, viewportWidth, viewportHeight);
      ctx.restore();
      return { width: viewportWidth, height: viewportHeight };
    }

    // Original PDF page
    const pageNumber = pageMeta.srcIndex + 1;
    const page = await this.pdfDoc.getPage(pageNumber);

    const totalRotation = (page.rotate + userRot) % 360;
    const viewport = page.getViewport({ scale: zoom, rotation: totalRotation });

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Fill white background before rendering
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport,
    };

    const renderTask = page.render(renderContext);
    this.pageRenderTasks.set(canvas, renderTask);

    try {
      await renderTask.promise;
      this.pageRenderTasks.delete(canvas);
    } catch (error) {
      if (error.name !== 'RenderingCancelledException') {
        console.error('Error rendering page:', error);
      }
    } finally {
      ctx.restore();
    }

    return { width: viewport.width, height: viewport.height };
  }

  // Render thumbnail for sidebar
  async renderThumbnail(displayPageIndex, canvas, targetWidth = 140) {
    const pageSize = this.getPageSize(displayPageIndex);
    const scale = targetWidth / pageSize.width;
    return this.renderPage(displayPageIndex, canvas, scale);
  }

  // Rotate a page 90 degrees
  rotatePage(displayPageIndex, degrees = 90) {
    if (displayPageIndex < 0 || displayPageIndex >= this.pageOrder.length) return;
    this.pageRotations[displayPageIndex] = (this.pageRotations[displayPageIndex] + degrees) % 360;
    return this.pageRotations[displayPageIndex];
  }

  // Delete page
  deletePage(displayPageIndex) {
    if (this.pageOrder.length <= 1) {
      throw new Error('Document must have at least one page');
    }
    this.pageOrder.splice(displayPageIndex, 1);
    this.pageRotations.splice(displayPageIndex, 1);
    return this.pageOrder.length;
  }

  // Duplicate page
  duplicatePage(displayPageIndex) {
    const meta = JSON.parse(JSON.stringify(this.pageOrder[displayPageIndex]));
    const rot = this.pageRotations[displayPageIndex];
    this.pageOrder.splice(displayPageIndex + 1, 0, meta);
    this.pageRotations.splice(displayPageIndex + 1, 0, rot);
    return displayPageIndex + 1;
  }

  // Add blank page
  addBlankPage(insertAfterIndex = null, width = 595.28, height = 841.89) {
    const targetIndex = insertAfterIndex === null ? this.pageOrder.length : insertAfterIndex + 1;
    this.pageOrder.splice(targetIndex, 0, {
      type: 'blank',
      width,
      height,
    });
    this.pageRotations.splice(targetIndex, 0, 0);
    return targetIndex;
  }

  // Add pages from another PDF file (ArrayBuffer or Uint8Array)
  async addPagesFromPDF(bytes, insertAfterIndex = null) {
    if (!window.PDFLib) {
      throw new Error('PDF-Lib library is not available');
    }

    const { PDFDocument } = window.PDFLib;
    const currentBytes = this.activePdfBytes || this.originalPdfBytes;

    if (!currentBytes || !this.pdfDoc) {
      return await this.loadPDF(bytes);
    }

    const mainDoc = await PDFDocument.load(currentBytes, { ignoreEncryption: true });
    const extDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    const extPageIndices = extDoc.getPageIndices();
    if (extPageIndices.length === 0) {
      return { addedCount: 0, firstPageIndex: insertAfterIndex !== null ? insertAfterIndex : 0, totalPageCount: this.pageOrder.length };
    }

    const startSrcIndex = mainDoc.getPageCount();
    const copiedPages = await mainDoc.copyPages(extDoc, extPageIndices);

    for (const page of copiedPages) {
      mainDoc.addPage(page);
    }

    const newBytes = await mainDoc.save();
    this.activePdfBytes = new Uint8Array(newBytes);

    // Cancel any ongoing renders
    this.pageRenderTasks.forEach(task => {
      try { task.cancel(); } catch (e) {}
    });
    this.pageRenderTasks.clear();

    // Reload PDF.js document proxy with merged bytes
    const workerBytes = new Uint8Array(this.activePdfBytes.length);
    workerBytes.set(this.activePdfBytes);

    this.pdfDoc = await window.pdfjsLib.getDocument({
      data: workerBytes,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }).promise;
    this.numPages = this.pdfDoc.numPages;

    const targetDisplayIndex = insertAfterIndex === null
      ? this.pageOrder.length
      : Math.max(0, Math.min(insertAfterIndex + 1, this.pageOrder.length));

    for (let i = 0; i < copiedPages.length; i++) {
      const srcIdx = startSrcIndex + i;
      const pdfJsPage = await this.pdfDoc.getPage(srcIdx + 1);
      const viewport = pdfJsPage.getViewport({ scale: 1.0 });

      this.pageSizes.push({
        width: viewport.width,
        height: viewport.height,
        originalRotation: pdfJsPage.rotate || 0,
      });

      this.pageOrder.splice(targetDisplayIndex + i, 0, {
        type: 'original',
        srcIndex: srcIdx,
        width: viewport.width,
        height: viewport.height,
      });

      this.pageRotations.splice(targetDisplayIndex + i, 0, 0);
    }

    return {
      addedCount: copiedPages.length,
      firstPageIndex: targetDisplayIndex,
      totalPageCount: this.pageOrder.length,
    };
  }

  // Move multiple pages (range or arbitrary selection) to a new position
  movePages(fromIndices, insertAfterIndex) {
    const total = this.pageOrder.length;
    if (!Array.isArray(fromIndices) || fromIndices.length === 0) return null;

    // Deduplicate and filter valid indices
    const selectedSet = new Set(fromIndices.filter(i => i >= 0 && i < total));
    if (selectedSet.size === 0) return null;

    // Check if target is inside the selected group (dropping inside selection is a no-op)
    if (selectedSet.has(insertAfterIndex)) {
      return null;
    }

    // Build tagged original array
    const originalItems = [];
    for (let i = 0; i < total; i++) {
      originalItems.push({
        origIndex: i,
        meta: this.pageOrder[i],
        rot: this.pageRotations[i],
        isSelected: selectedSet.has(i)
      });
    }

    // Separate selected items and remaining items
    const selectedItems = originalItems.filter(item => item.isSelected);
    const remainingItems = originalItems.filter(item => !item.isSelected);

    // Find insertion index in remainingItems
    let insertPos = 0;
    if (insertAfterIndex === -1) {
      insertPos = 0;
    } else {
      const refIdx = remainingItems.findIndex(item => item.origIndex === insertAfterIndex);
      if (refIdx !== -1) {
        insertPos = refIdx + 1;
      } else {
        let lastBefore = -1;
        for (let r = 0; r < remainingItems.length; r++) {
          if (remainingItems[r].origIndex < insertAfterIndex) {
            lastBefore = r;
          }
        }
        insertPos = lastBefore + 1;
      }
    }

    // Splice selected items into remainingItems at insertPos
    remainingItems.splice(insertPos, 0, ...selectedItems);

    // Update this.pageOrder and this.pageRotations, and build index map
    const oldIndexToNewIndex = new Map();
    const newPageOrder = [];
    const newPageRotations = [];

    for (let newIdx = 0; newIdx < remainingItems.length; newIdx++) {
      const item = remainingItems[newIdx];
      oldIndexToNewIndex.set(item.origIndex, newIdx);
      newPageOrder.push(item.meta);
      newPageRotations.push(item.rot);
    }

    this.pageOrder = newPageOrder;
    this.pageRotations = newPageRotations;

    const newMovedIndices = selectedItems.map(item => oldIndexToNewIndex.get(item.origIndex));
    return {
      oldIndexToNewIndex,
      newMovedIndices,
      firstNewIndex: newMovedIndices[0]
    };
  }

  // Move single page (reorder)
  movePage(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 ||
        fromIndex >= this.pageOrder.length || toIndex >= this.pageOrder.length) {
      return null;
    }
    const insertAfterIndex = fromIndex < toIndex ? toIndex : toIndex - 1;
    return this.movePages([fromIndex], insertAfterIndex);
  }

  // Helper: Convert hex color to PDF-Lib rgb
  hexToPdfRgb(hex) {
    if (!hex) return window.PDFLib.rgb(0, 0, 0);
    hex = hex.replace('#', '');
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return window.PDFLib.rgb(r || 0, g || 0, b || 0);
  }

  // Render high-res drawing strokes to PNG overlay for a page
  renderStrokesToPng(annotations, pageWidth, pageHeight) {
    const drawingAnnotations = annotations.filter(a =>
      a.type === 'freehand' || a.type === 'highlighter'
    );
    if (drawingAnnotations.length === 0) return null;

    const offscreen = document.createElement('canvas');
    const scale = 2.0; // 2x resolution for crisp raster overlay
    offscreen.width = Math.floor(pageWidth * scale);
    offscreen.height = Math.floor(pageHeight * scale);
    const ctx = offscreen.getContext('2d');
    ctx.scale(scale, scale);

    drawingAnnotations.forEach(ann => {
      if (!ann.points || ann.points.length < 2) return;

      ctx.save();
      ctx.beginPath();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ann.strokeColor || '#000000';
      ctx.lineWidth = ann.strokeWidth || 3;

      if (ann.type === 'highlighter') {
        ctx.globalAlpha = ann.opacity || 0.45;
      } else {
        ctx.globalAlpha = ann.opacity || 1.0;
      }

      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(ann.points[i].x, ann.points[i].y);
      }
      ctx.stroke();
      ctx.restore();
    });

    return offscreen.toDataURL('image/png');
  }

  // Export full modified PDF
  async exportPDF(annotationManager, customFilename = null) {
    if (!window.PDFLib) {
      throw new Error('PDF-Lib library is not available');
    }

    const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
    let outDoc = null;

    const srcBytes = this.activePdfBytes || this.originalPdfBytes;
    if (srcBytes && srcBytes.length > 0) {
      const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
      outDoc = await PDFDocument.create();

      // Copy standard fonts
      const fontHelvetica = await outDoc.embedFont(StandardFonts.Helvetica);
      const fontHelveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const fontTimes = await outDoc.embedFont(StandardFonts.TimesRoman);
      const fontTimesBold = await outDoc.embedFont(StandardFonts.TimesRomanBold);
      const fontCourier = await outDoc.embedFont(StandardFonts.Courier);
      const fontCourierBold = await outDoc.embedFont(StandardFonts.CourierBold);

      const getFont = (family, weight) => {
        const isBold = weight === 'bold';
        if (family && family.toLowerCase().includes('times')) {
          return isBold ? fontTimesBold : fontTimes;
        }
        if (family && family.toLowerCase().includes('courier')) {
          return isBold ? fontCourierBold : fontCourier;
        }
        return isBold ? fontHelveticaBold : fontHelvetica;
      };

      // Process each page according to pageOrder
      for (let displayIdx = 0; displayIdx < this.pageOrder.length; displayIdx++) {
        const meta = this.pageOrder[displayIdx];
        let targetPage = null;

        if (meta.type === 'original') {
          const [copiedPage] = await outDoc.copyPages(srcDoc, [meta.srcIndex]);
          targetPage = outDoc.addPage(copiedPage);
        } else {
          targetPage = outDoc.addPage([meta.width, meta.height]);
        }

        // Apply rotation
        const userRot = this.pageRotations[displayIdx] || 0;
        if (userRot !== 0) {
          const currentRot = targetPage.getRotation().angle;
          targetPage.setRotation(degrees((currentRot + userRot) % 360));
        }

        const pageWidth = targetPage.getWidth();
        const pageHeight = targetPage.getHeight();

        // Get annotations for this page
        const pageAnnotations = annotationManager.getAnnotationsForPage(displayIdx);

        // 1. High-res drawings overlay (freehand & highlighter)
        const drawingPng = this.renderStrokesToPng(pageAnnotations, pageWidth, pageHeight);
        if (drawingPng) {
          try {
            const pngImage = await outDoc.embedPng(drawingPng);
            targetPage.drawImage(pngImage, {
              x: 0,
              y: 0,
              width: pageWidth,
              height: pageHeight,
            });
          } catch (e) {
            console.error('Error embedding freehand stroke overlay:', e);
          }
        }

        // 2. Render discrete elements
        for (const ann of pageAnnotations) {
          // In PDF, origin (0, 0) is bottom-left, y goes upward
          // In canvas, origin is top-left, y goes downward
          const x = ann.x;
          const y = pageHeight - (ann.y + ann.height);
          const w = ann.width;
          const h = ann.height;

          // TEXT
          if (ann.type === 'text') {
            const font = getFont(ann.fontFamily, ann.fontWeight);
            const fontSize = ann.fontSize || 14;
            const textColor = this.hexToPdfRgb(ann.fontColor || '#000000');
            const lines = (ann.text || '').split('\n');

            // Draw optional background
            if (ann.backgroundColor && ann.backgroundColor !== 'transparent') {
              targetPage.drawRectangle({
                x: ann.x,
                y: pageHeight - (ann.y + ann.height),
                width: ann.width,
                height: ann.height,
                color: this.hexToPdfRgb(ann.backgroundColor),
              });
            }

            const lineHeight = fontSize * 1.25;
            let currentLineY = (ann.baselineY !== undefined && ann.baselineY !== null)
              ? (pageHeight - ann.baselineY) 
              : (pageHeight - ann.y - (fontSize * 0.82));

            for (const line of lines) {
              if (line.length > 0) {
                targetPage.drawText(line, {
                  x: ann.x,
                  y: currentLineY,
                  size: fontSize,
                  font: font,
                  color: textColor,
                });
              }
              currentLineY -= lineHeight;
            }
          }

          // RECTANGLE
          else if (ann.type === 'rect') {
            const rectOpts = {
              x: x,
              y: y,
              width: w,
              height: h,
              borderWidth: ann.strokeWidth || 1,
              borderColor: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
            };

            if (ann.fillColor && ann.fillColor !== 'transparent') {
              rectOpts.color = this.hexToPdfRgb(ann.fillColor);
            }
            if (ann.opacity !== undefined) {
              rectOpts.opacity = ann.opacity;
            }

            targetPage.drawRectangle(rectOpts);
          }

          // CIRCLE / ELLIPSE
          else if (ann.type === 'circle') {
            const xRadius = w / 2;
            const yRadius = h / 2;
            const ellipseOpts = {
              x: x + xRadius,
              y: y + yRadius,
              xScale: xRadius,
              yScale: yRadius,
              borderWidth: ann.strokeWidth || 1,
              borderColor: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
            };

            if (ann.fillColor && ann.fillColor !== 'transparent') {
              ellipseOpts.color = this.hexToPdfRgb(ann.fillColor);
            }
            if (ann.opacity !== undefined) {
              ellipseOpts.opacity = ann.opacity;
            }

            targetPage.drawEllipse(ellipseOpts);
          }

          // LINE
          else if (ann.type === 'line') {
            targetPage.drawLine({
              start: { x: ann.x, y: pageHeight - ann.y },
              end: { x: ann.x + ann.width, y: pageHeight - (ann.y + ann.height) },
              thickness: ann.strokeWidth || 2,
              color: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
              opacity: ann.opacity !== undefined ? ann.opacity : 1.0,
            });
          }

          // ARROW
          else if (ann.type === 'arrow') {
            const startX = ann.x;
            const startY = pageHeight - ann.y;
            const endX = ann.x + ann.width;
            const endY = pageHeight - (ann.y + ann.height);

            targetPage.drawLine({
              start: { x: startX, y: startY },
              end: { x: endX, y: endY },
              thickness: ann.strokeWidth || 2,
              color: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
            });

            // Arrowhead calculations
            const angle = Math.atan2(endY - startY, endX - startX);
            const headLength = Math.max(10, (ann.strokeWidth || 2) * 4);
            const leftAngle = angle + Math.PI * 0.85;
            const rightAngle = angle - Math.PI * 0.85;

            targetPage.drawLine({
              start: { x: endX, y: endY },
              end: { x: endX + headLength * Math.cos(leftAngle), y: endY + headLength * Math.sin(leftAngle) },
              thickness: ann.strokeWidth || 2,
              color: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
            });
            targetPage.drawLine({
              start: { x: endX, y: endY },
              end: { x: endX + headLength * Math.cos(rightAngle), y: endY + headLength * Math.sin(rightAngle) },
              thickness: ann.strokeWidth || 2,
              color: this.hexToPdfRgb(ann.strokeColor || '#3b82f6'),
            });
          }

          // WHITEOUT (Erase / Redact White)
          else if (ann.type === 'whiteout') {
            targetPage.drawRectangle({
              x: x,
              y: y,
              width: w,
              height: h,
              color: rgb(1, 1, 1),
              opacity: 1.0,
            });
          }

          // BLACKOUT (Redact Black)
          else if (ann.type === 'blackout') {
            targetPage.drawRectangle({
              x: x,
              y: y,
              width: w,
              height: h,
              color: rgb(0, 0, 0),
              opacity: 1.0,
            });
          }

          // CHECKMARK & CROSS
          else if (ann.type === 'checkmark') {
            // Draw clean vector checkmark
            const checkColor = this.hexToPdfRgb(ann.strokeColor || '#10b981');
            const p1 = { x: ann.x + w * 0.15, y: pageHeight - (ann.y + h * 0.55) };
            const p2 = { x: ann.x + w * 0.42, y: pageHeight - (ann.y + h * 0.85) };
            const p3 = { x: ann.x + w * 0.88, y: pageHeight - (ann.y + h * 0.18) };

            targetPage.drawLine({ start: p1, end: p2, thickness: Math.max(2, w * 0.1), color: checkColor });
            targetPage.drawLine({ start: p2, end: p3, thickness: Math.max(2, w * 0.1), color: checkColor });
          } else if (ann.type === 'cross') {
            const crossColor = this.hexToPdfRgb(ann.strokeColor || '#ef4444');
            const thick = Math.max(2, w * 0.1);
            targetPage.drawLine({
              start: { x: ann.x + w * 0.2, y: pageHeight - (ann.y + h * 0.2) },
              end: { x: ann.x + w * 0.8, y: pageHeight - (ann.y + h * 0.8) },
              thickness: thick,
              color: crossColor,
            });
            targetPage.drawLine({
              start: { x: ann.x + w * 0.8, y: pageHeight - (ann.y + h * 0.2) },
              end: { x: ann.x + w * 0.2, y: pageHeight - (ann.y + h * 0.8) },
              thickness: thick,
              color: crossColor,
            });
          }

          // IMAGE & SIGNATURE
          else if (ann.type === 'image' || ann.type === 'signature') {
            if (ann.imgDataUrl) {
              try {
                let imgObj = null;
                if (ann.imgDataUrl.includes('image/jpeg') || ann.imgDataUrl.includes('image/jpg')) {
                  imgObj = await outDoc.embedJpg(ann.imgDataUrl);
                } else {
                  imgObj = await outDoc.embedPng(ann.imgDataUrl);
                }

                targetPage.drawImage(imgObj, {
                  x: x,
                  y: y,
                  width: w,
                  height: h,
                  opacity: ann.opacity !== undefined ? ann.opacity : 1.0,
                });
              } catch (e) {
                console.error('Error embedding image/signature:', e);
              }
            }
          }
        }
      }
    }

    if (!outDoc) {
      outDoc = await PDFDocument.create();
    }

    const exportedBytes = await outDoc.save();
    const finalFilename = customFilename || this.filename || 'document.pdf';

    // Trigger browser download
    const blob = new Blob([exportedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = finalFilename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 1000);

    return {
      bytes: exportedBytes,
      size: exportedBytes.length,
      filename: finalFilename,
    };
  }

  // Export single page as PNG image
  async exportPageAsImage(displayPageIndex, annotationManager) {
    const pageSize = this.getPageSize(displayPageIndex);
    const scale = 2.0; // Crisp 2x export

    const combinedCanvas = document.createElement('canvas');
    combinedCanvas.width = Math.floor(pageSize.width * scale);
    combinedCanvas.height = Math.floor(pageSize.height * scale);
    const ctx = combinedCanvas.getContext('2d');

    // Render PDF page to canvas
    await this.renderPage(displayPageIndex, combinedCanvas, scale);

    // Now render annotations on top of canvas
    const annotations = annotationManager.getAnnotationsForPage(displayPageIndex);
    ctx.scale(scale, scale);

    // Freehand & highlighters
    annotations.forEach(ann => {
      if ((ann.type === 'freehand' || ann.type === 'highlighter') && ann.points && ann.points.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ann.strokeColor || '#000000';
        ctx.lineWidth = ann.strokeWidth || 3;
        ctx.globalAlpha = ann.type === 'highlighter' ? (ann.opacity || 0.45) : (ann.opacity || 1.0);
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        ctx.stroke();
        ctx.restore();
      }
    });

    // Rectangles, text, etc.
    for (const ann of annotations) {
      if (ann.type === 'text') {
        ctx.save();
        if (ann.backgroundColor && ann.backgroundColor !== 'transparent') {
          ctx.fillStyle = ann.backgroundColor;
          ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
        }
        ctx.font = `${ann.fontWeight || 'normal'} ${ann.fontSize || 14}px ${ann.fontFamily || 'Helvetica'}`;
        ctx.fillStyle = ann.fontColor || '#000000';
        const lines = (ann.text || '').split('\n');
        const lineHeight = (ann.fontSize || 14) * 1.25;
        let y = ann.y + (ann.fontSize || 14) * 0.9;
        for (const line of lines) {
          ctx.fillText(line, ann.x + 2, y);
          y += lineHeight;
        }
        ctx.restore();
      } else if (ann.type === 'rect') {
        ctx.save();
        if (ann.fillColor && ann.fillColor !== 'transparent') {
          ctx.fillStyle = ann.fillColor;
          ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
        }
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
        ctx.restore();
      } else if (ann.type === 'whiteout') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      } else if (ann.type === 'blackout') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      } else if (ann.type === 'image' || ann.type === 'signature') {
        if (ann.imgDataUrl) {
          const img = new Image();
          await new Promise(res => {
            img.onload = res;
            img.src = ann.imgDataUrl;
          });
          ctx.drawImage(img, ann.x, ann.y, ann.width, ann.height);
        }
      }
    }

    const dataUrl = combinedCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `page_${displayPageIndex + 1}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

window.PDFEngine = PDFEngine;
