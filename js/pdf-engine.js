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
                  const rawFontName = font.name || font.loadedName || style.fontFamily || '';
                  const name = rawFontName.toLowerCase();
                  const isBold = !!(font.bold || font.black || /bold|black|heavy|medium|w[7-9]|demi/i.test(name));
                  const isItalic = !!(font.italic || /italic|oblique/i.test(name));

                  let family = 'Helvetica';
                  if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.isThaiFontName && window.ThaiSupport.isThaiFontName(rawFontName)) {
                    family = 'Sarabun';
                  } else if (/times|roman|minion|georgia|serif/i.test(name) || font.fallbackName === 'serif') {
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
            if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.isThaiFontName && window.ThaiSupport.isThaiFontName(style.fontFamily || fontId || '')) {
              fontInfo.family = 'Sarabun';
            } else if (/times|roman|serif/i.test(raw)) {
              fontInfo.family = 'Times New Roman';
            } else if (/courier|mono/i.test(raw)) {
              fontInfo.family = 'Courier New';
            }
          }

          fontCache[fontId] = fontInfo;
        }
      }

      await Promise.all(fontPromises);

      const rawItems = [];
      for (const item of textContent.items) {
        const rawStr = item.str || '';
        const normStr = (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText)
          ? window.ThaiSupport.normalizeThaiText(rawStr)
          : rawStr;
        if (!normStr || normStr.trim().length === 0) continue;

        const isThai = (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.containsThai)
          ? window.ThaiSupport.containsThai(normStr)
          : /[\u0E00-\u0E7F\uF700-\uF71A]/.test(normStr);

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

        let effectiveFamily = font.family;
        if (isThai && effectiveFamily !== 'Sarabun') {
          effectiveFamily = 'Sarabun';
        }

        const ascent = Math.min(1.0, Math.max(0.65, font.ascent || 0.75));
        const descent = Math.min(0, Math.max(-0.35, font.descent || -0.22));

        const ascentPx = Math.floor(fontSize * 0.89);
        const normUserRot = ((this.pageRotations[displayPageIndex] || 0) % 360 + 360) % 360;
        let tlX = ptX;
        let tlY = Math.max(0, ptY - ascentPx);

        if (normUserRot === 90) {
          tlX = ptX + ascentPx;
          tlY = ptY;
        } else if (normUserRot === 180) {
          tlX = ptX;
          tlY = ptY + ascentPx;
        } else if (normUserRot === 270) {
          tlX = ptX - ascentPx;
          tlY = ptY;
        }

        const lineHeight = isThai
          ? Math.max((ascent - descent) * fontSize + 6, fontSize * 1.42)
          : ((ascent - descent) * fontSize + 2);
        const itemW = Math.round(item.width || (normStr.length * fontSize * 0.55));
        const itemH = Math.round(lineHeight);

        let minX = tlX, minY = tlY, maxX = tlX + itemW, maxY = tlY + itemH;
        if (normUserRot === 90) {
          minX = tlX - itemH;
          minY = tlY;
          maxX = tlX;
          maxY = tlY + itemW;
        } else if (normUserRot === 180) {
          minX = tlX - itemW;
          minY = tlY - itemH;
          maxX = tlX;
          maxY = tlY;
        } else if (normUserRot === 270) {
          minX = tlX;
          minY = tlY - itemW;
          maxX = tlX + itemH;
          maxY = tlY;
        }

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

        rawItems.push({
          str: normStr,
          x: +(tlX.toFixed(2)),
          y: +(tlY.toFixed(2)),
          minX: +(minX.toFixed(2)),
          minY: +(minY.toFixed(2)),
          maxX: +(maxX.toFixed(2)),
          maxY: +(maxY.toFixed(2)),
          rotation: normUserRot,
          baselineY: +(ptY.toFixed(2)),
          width: itemW,
          height: itemH,
          fontSize: +(fontSize.toFixed(2)),
          fontFamily: effectiveFamily,
          fontWeight: font.bold ? 'bold' : 'normal',
          fontStyle: font.italic ? 'italic' : 'normal',
          fontColor: fontColor,
          fontName: item.fontName,
          rawTx: rawTx,
          rawTy: rawTy,
          isThai: isThai,
        });
      }

      // Merge Split Thai Combining Marks / Syllables on the Same Line
      const items = [];
      for (let i = 0; i < rawItems.length; i++) {
        const curr = rawItems[i];
        if (items.length > 0) {
          const prev = items[items.length - 1];
          const rawGap = (curr.rawTx !== undefined && prev.rawTx !== undefined)
            ? (curr.rawTx - (prev.rawTx + prev.width))
            : (curr.x - (prev.x + prev.width));
          const isSameLine = (prev.rotation === curr.rotation) && (Math.abs(prev.rawTy - curr.rawTy) <= 2.0);
          const isCombining = /^[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]/.test(curr.str);
          const isAdjacentThai = prev.isThai && curr.isThai && (rawGap >= -3.0 && rawGap <= 1.5);

          if (isSameLine && (isCombining || isAdjacentThai)) {
            prev.str = (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText)
              ? window.ThaiSupport.normalizeThaiText(prev.str + curr.str)
              : (prev.str + curr.str);
            prev.isThai = true;
            prev.fontFamily = 'Sarabun';
            if (curr.rawTx !== undefined && prev.rawTx !== undefined) {
              prev.width = Math.max(prev.width, Math.round((curr.rawTx + curr.width) - prev.rawTx));
            } else {
              prev.width = prev.width + curr.width;
            }
            prev.minX = Math.min(prev.minX, curr.minX);
            prev.minY = Math.min(prev.minY, curr.minY);
            prev.maxX = Math.max(prev.maxX, curr.maxX);
            prev.maxY = Math.max(prev.maxY, curr.maxY);
            prev.height = Math.max(prev.height, curr.height);
            continue;
          }
        }
        items.push(curr);
      }

      return items;
    } catch (e) {
      console.warn('Could not extract text content:', e);
      return [];
    }
  }

  // Extract vector lines from page operator list
  async getVectorLines(displayPageIndex) {
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta || pageMeta.type === 'blank') return [];

    try {
      const page = await this.pdfDoc.getPage(pageMeta.srcIndex + 1);
      const rotation = this.pageRotations[displayPageIndex] || 0;
      const viewport = page.getViewport({ scale: 1.0, rotation });
      const opList = await page.getOperatorList();
      if (!opList || !opList.fnArray) return [];

      const OPS = (typeof window !== 'undefined' && window.pdfjsLib && window.pdfjsLib.OPS)
        ? window.pdfjsLib.OPS
        : {
          save: 1,
          restore: 2,
          transform: 3,
          moveTo: 13,
          lineTo: 14,
          rectangle: 19,
          constructPath: 91,
          setStrokeRGBColor: 25,
          setStrokeGray: 27,
          setLineWidth: 22,
        };

      let ctm = [1, 0, 0, 1, 0, 0];
      const ctmStack = [];
      let curStrokeColor = '#000000';
      let curLineWidth = 1;

      const multiplyMatrix = (m1, m2) => [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ];

      const transformPoint = (m, x, y) => [
        m[0] * x + m[2] * y + m[4],
        m[1] * x + m[3] * y + m[5],
      ];

      const rawLines = [];

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];

        if (fn === OPS.save || fn === 1) {
          ctmStack.push([...ctm]);
        } else if (fn === OPS.restore || fn === 2) {
          ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        } else if ((fn === OPS.transform || fn === 3) && args) {
          ctm = multiplyMatrix(ctm, args);
        } else if (fn === OPS.setStrokeRGBColor && args) {
          const r = Math.round((args[0] || 0) * 255);
          const g = Math.round((args[1] || 0) * 255);
          const b = Math.round((args[2] || 0) * 255);
          curStrokeColor = `rgb(${r},${g},${b})`;
        } else if (fn === OPS.setStrokeGray && args) {
          const g = Math.round((args[0] || 0) * 255);
          curStrokeColor = `rgb(${g},${g},${g})`;
        } else if (fn === OPS.setLineWidth && args) {
          curLineWidth = args[0] || 1;
        } else if ((fn === OPS.constructPath || fn === 91 || fn === 92) && args) {
          const subOps = args[0] || [];
          const coords = args[1] || [];
          let cIdx = 0;
          let curVx = 0, curVy = 0;
          let curTx = 0, curTy = 0;

          for (let s = 0; s < subOps.length; s++) {
            const op = subOps[s];
            if (op === 13 || op === OPS.moveTo) {
              const rawX = coords[cIdx], rawY = coords[cIdx + 1];
              const [tx, ty] = transformPoint(ctm, rawX, rawY);
              const [vx, vy] = viewport.convertToViewportPoint(tx, ty);
              curVx = vx; curVy = vy;
              curTx = rawX; curTy = rawY;
              cIdx += 2;
            } else if (op === 14 || op === OPS.lineTo) {
              const rawX = coords[cIdx], rawY = coords[cIdx + 1];
              const [tx, ty] = transformPoint(ctm, rawX, rawY);
              const [vx, vy] = viewport.convertToViewportPoint(tx, ty);

              rawLines.push({
                x1: curVx,
                y1: curVy,
                x2: vx,
                y2: vy,
                rawX1: curTx,
                rawY1: curTy,
                rawX2: rawX,
                rawY2: rawY,
                strokeColor: curStrokeColor,
                strokeWidth: curLineWidth,
              });

              curVx = vx; curVy = vy;
              curTx = rawX; curTy = rawY;
              cIdx += 2;
            } else if (op === 15 || op === OPS.curveTo) {
              cIdx += 6;
            } else if (op === 16 || op === OPS.curveTo2 || op === 17 || op === OPS.curveTo3) {
              cIdx += 4;
            } else if (op === 18 || op === OPS.closePath) {
              // closePath
            } else if (op === 19 || op === OPS.rectangle) {
              const rx = coords[cIdx], ry = coords[cIdx + 1], rw = coords[cIdx + 2], rh = coords[cIdx + 3];
              cIdx += 4;
              const [tx1, ty1] = transformPoint(ctm, rx, ry + rh);
              const [tx2, ty2] = transformPoint(ctm, rx + rw, ry);
              const [vx1, vy1] = viewport.convertToViewportPoint(tx1, ty1);
              const [vx2, vy2] = viewport.convertToViewportPoint(tx2, ty2);

              const left = Math.min(vx1, vx2), right = Math.max(vx1, vx2);
              const top = Math.min(vy1, vy2), bottom = Math.max(vy1, vy2);
              const w = right - left, h = bottom - top;

              if (h <= 3.5 && w >= 4) {
                const midY = (top + bottom) / 2;
                rawLines.push({
                  x1: left, y1: midY, x2: right, y2: midY,
                  rawX1: rx, rawY1: ry + rh / 2, rawX2: rx + rw, rawY2: ry + rh / 2,
                  strokeColor: curStrokeColor, strokeWidth: h || curLineWidth,
                });
              } else if (w <= 3.5 && h >= 4) {
                const midX = (left + right) / 2;
                rawLines.push({
                  x1: midX, y1: top, x2: midX, y2: bottom,
                  rawX1: rx + rw / 2, rawY1: ry, rawX2: rx + rw / 2, rawY2: ry + rh,
                  strokeColor: curStrokeColor, strokeWidth: w || curLineWidth,
                });
              } else if (w >= 4 && h >= 4) {
                rawLines.push({
                  x1: left, y1: top, x2: right, y2: top,
                  rawX1: rx, rawY1: ry + rh, rawX2: rx + rw, rawY2: ry + rh,
                  strokeColor: curStrokeColor, strokeWidth: curLineWidth,
                });
                rawLines.push({
                  x1: left, y1: bottom, x2: right, y2: bottom,
                  rawX1: rx, rawY1: ry, rawX2: rx + rw, rawY2: ry,
                  strokeColor: curStrokeColor, strokeWidth: curLineWidth,
                });
                rawLines.push({
                  x1: left, y1: top, x2: left, y2: bottom,
                  rawX1: rx, rawY1: ry, rawX2: rx, rawY2: ry + rh,
                  strokeColor: curStrokeColor, strokeWidth: curLineWidth,
                });
                rawLines.push({
                  x1: right, y1: top, x2: right, y2: bottom,
                  rawX1: rx + rw, rawY1: ry, rawX2: rx + rw, rawY2: ry + rh,
                  strokeColor: curStrokeColor, strokeWidth: curLineWidth,
                });
              }
            }
          }
        }
      }

      const filtered = [];
      let lineCounter = 0;

      for (const l of rawLines) {
        const segLen = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
        if (segLen < 4) continue;

        const left = Math.min(l.x1, l.x2);
        const top = Math.min(l.y1, l.y2);
        const w = Math.abs(l.x2 - l.x1);
        const h = Math.abs(l.y2 - l.y1);

        if (w >= viewport.width - 5 && h >= viewport.height - 5) continue;

        lineCounter++;
        filtered.push({
          id: `pdfline_${displayPageIndex}_${lineCounter}`,
          pageIndex: displayPageIndex,
          x: +(left.toFixed(2)),
          y: +(top.toFixed(2)),
          width: +(w.toFixed(2)),
          height: +(h.toFixed(2)),
          x1: +(l.x1.toFixed(2)),
          y1: +(l.y1.toFixed(2)),
          x2: +(l.x2.toFixed(2)),
          y2: +(l.y2.toFixed(2)),
          rawX1: l.rawX1 !== undefined ? +(l.rawX1.toFixed(2)) : undefined,
          rawY1: l.rawY1 !== undefined ? +(l.rawY1.toFixed(2)) : undefined,
          rawX2: l.rawX2 !== undefined ? +(l.rawX2.toFixed(2)) : undefined,
          rawY2: l.rawY2 !== undefined ? +(l.rawY2.toFixed(2)) : undefined,
          strokeColor: l.strokeColor || '#000000',
          strokeWidth: +(l.strokeWidth.toFixed(2)) || 1,
        });
      }

      return filtered;
    } catch (e) {
      console.warn('Could not extract vector lines:', e);
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

  // Blank out multiple target texts in decompressed content stream string in a single efficient pass
  redactMultipleTextsFromStreamString(streamText, targets) {
    if (!targets || targets.length === 0 || !streamText) return streamText;

    // Scan stream ONCE to track text position (Td, TD, Tm, T*, TL, Ts) and collect string tokens
    const tokenRegex = /\b(BT|ET)\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm\b|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(Td|TD)\b|(-?\d+(?:\.\d+)?)\s+TL\b|\b(T\*)\b|(-?\d+(?:\.\d+)?)\s+Ts\b|\((?:[^\\()]|\\.)*\)|<([0-9a-fA-F\s]+)>/g;

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
        let norm = decoded.replace(/\s+/g, ' ').trim();
        if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText) {
          norm = window.ThaiSupport.normalizeThaiText(norm);
        }
        tokens.push({
          start: m.index,
          end: m.index + full.length,
          rawMatch: full,
          isHex: false,
          decoded,
          currentDecoded: decoded,
          currentReplacement: null,
          isDirty: false,
          norm,
          x: curX,
          rawY: curY,
          effY: curY + textRise * scaleY,
        });
      } else if (full.startsWith('<') && m[14] !== undefined) {
        const hexChars = m[14].replace(/\s+/g, '');
        let decoded = '';
        for (let i = 0; i < hexChars.length; i += 2) {
          decoded += String.fromCharCode(parseInt(hexChars.substring(i, i + 2), 16));
        }
        let norm = decoded.replace(/\s+/g, ' ').trim();
        if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText) {
          norm = window.ThaiSupport.normalizeThaiText(norm);
        }
        tokens.push({
          start: m.index,
          end: m.index + full.length,
          rawMatch: full,
          isHex: true,
          decoded,
          currentDecoded: decoded,
          currentReplacement: null,
          isDirty: false,
          norm,
          x: curX,
          rawY: curY,
          effY: curY + textRise * scaleY,
        });
      }
    }

    if (tokens.length === 0) return streamText;

    // Index tokens by Y buckets for O(1) same-line lookups (using effective Y so textRise Ts doesn't bleed across lines)
    const yBuckets = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const bMin = Math.floor((tok.effY - 3.0) / 5);
      const bMax = Math.floor((tok.effY + 3.0) / 5);
      for (let b = bMin; b <= bMax; b++) {
        let list = yBuckets.get(b);
        if (!list) {
          list = [];
          yBuckets.set(b, list);
        }
        list.push(tok);
      }
    }

    for (let tIdx = 0; tIdx < targets.length; tIdx++) {
      const target = targets[tIdx];
      const targetStr = target.targetStr;
      const rawTx = target.rawTx;
      const rawTy = target.rawTy;
      if (!targetStr) continue;
      const normTarget = (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText)
        ? window.ThaiSupport.normalizeThaiText(targetStr).replace(/\s+/g, ' ').trim()
        : targetStr.replace(/\s+/g, ' ').trim();
      if (!normTarget) continue;

      const hasCoords = (rawTx !== null && rawTx !== undefined && rawTy !== null && rawTy !== undefined);
      let foundForTarget = false;

      if (hasCoords) {
        const b = Math.floor(rawTy / 5);
        const candidates = yBuckets.get(b) || [];
        const getYDiff = (tok) => Math.abs(tok.effY - rawTy);
        const sameLineTokens = candidates.filter(tok => getYDiff(tok) <= 2.5);

        // Priority 1: Exact string match on the same line closest to rawTx
        const exactOnLine = sameLineTokens.filter(tok => {
          const curNorm = tok.currentDecoded ? tok.currentDecoded.replace(/\s+/g, ' ').trim() : tok.norm;
          return curNorm.length > 0 && curNorm === normTarget;
        });
        if (exactOnLine.length > 0) {
          exactOnLine.sort((a, b) => Math.abs(a.x - rawTx) - Math.abs(b.x - rawTx));
          const best = exactOnLine[0];
          best.currentDecoded = '';
          best.currentReplacement = best.isHex ? '<>' : '()';
          best.isDirty = true;
          foundForTarget = true;
          target._redactedInStream = true;
        }

        // Priority 2: Adjacent tokens on the same line that PDF.js merged into targetStr
        if (!foundForTarget && sameLineTokens.length > 1) {
          const sortedLine = [...sameLineTokens].filter(tok => (tok.currentDecoded !== undefined ? tok.currentDecoded : tok.norm).length > 0).sort((a, b) => a.x - b.x);
          for (let i = 0; i < sortedLine.length; i++) {
            if (Math.abs(sortedLine[i].x - rawTx) > 20) continue;
            let combined = '';
            const group = [];
            for (let j = i; j < sortedLine.length; j++) {
              const curNorm = sortedLine[j].currentDecoded ? sortedLine[j].currentDecoded.replace(/\s+/g, ' ').trim() : sortedLine[j].norm;
              combined = combined ? (combined + ' ' + curNorm) : curNorm;
              group.push(sortedLine[j]);
              if (combined === normTarget) {
                for (const g of group) {
                  g.currentDecoded = '';
                  g.currentReplacement = g.isHex ? '<>' : '()';
                  g.isDirty = true;
                }
                foundForTarget = true;
                target._redactedInStream = true;
                break;
              }
              if (combined.length >= normTarget.length) break;
            }
            if (foundForTarget) break;
          }
        }

        // Priority 3: Single token on the same line that PDF.js split into multiple items
        if (!foundForTarget) {
          const containerCandidates = sameLineTokens.filter(tok => {
            const curText = tok.currentDecoded !== undefined ? tok.currentDecoded : tok.decoded;
            let curNorm = curText.replace(/\s+/g, ' ').trim();
            if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText) {
              curNorm = window.ThaiSupport.normalizeThaiText(curNorm);
            }
            return curNorm.length > 0 && curNorm.includes(normTarget) && tok.x <= rawTx + 15;
          });
          if (containerCandidates.length > 0) {
            containerCandidates.sort((a, b) => Math.abs(a.x - rawTx) - Math.abs(b.x - rawTx));
            const targetTok = containerCandidates[0];
            if (!targetTok.isHex) {
              const escapedTargetPattern = normTarget
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\s+/g, '\\s+');
              const subRegex = new RegExp(escapedTargetPattern);
              const curDecoded = targetTok.currentDecoded !== undefined ? targetTok.currentDecoded : targetTok.decoded;
              const matchSub = subRegex.exec(curDecoded);
              if (matchSub) {
                const before = curDecoded.slice(0, matchSub.index);
                const matchedStr = matchSub[0];
                const after = curDecoded.slice(matchSub.index + matchedStr.length);
                const isOnlyLeftPart = after.trim().length > 0;
                const newDecoded = before + (isOnlyLeftPart ? matchedStr.replace(/\S/g, '  ') : matchedStr.replace(/\S/g, ' ')) + after;
                targetTok.currentDecoded = newDecoded;
                targetTok.currentReplacement = newDecoded.trim().length === 0
                  ? '()'
                  : `(${this.escapePdfLiteral(newDecoded)})`;
                targetTok.isDirty = true;
                foundForTarget = true;
                target._redactedInStream = true;
              }
            } else {
              targetTok.currentDecoded = '';
              targetTok.currentReplacement = '<>';
              targetTok.isDirty = true;
              foundForTarget = true;
              target._redactedInStream = true;
            }
          }
        }

        // Priority 4: Coordinate-Matched CID / Identity-H / Hex Token Excision
        if (!foundForTarget) {
          const isEligibleForP4 = (tok) => tok.isHex ||
            (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.containsThai(normTarget)) ||
            (tok.decoded && /[^\x20-\x7E]/.test(tok.decoded));
          const coordCandidates = sameLineTokens.filter(tok => isEligibleForP4(tok) && Math.abs(tok.x - rawTx) <= 8.0);
          if (coordCandidates.length > 0) {
            let closestTok = coordCandidates[0];
            let minDiff = Math.abs(closestTok.x - rawTx);
            for (let i = 1; i < coordCandidates.length; i++) {
              const diff = Math.abs(coordCandidates[i].x - rawTx);
              if (diff < minDiff) {
                minDiff = diff;
                closestTok = coordCandidates[i];
              }
            }
            const bestX = closestTok.x;
            const tokensAtBestX = sameLineTokens.filter(tok => Math.abs(tok.x - bestX) <= 1.5);
            for (const tok of tokensAtBestX) {
              tok.currentDecoded = '';
              tok.currentReplacement = tok.isHex ? '<>' : '()';
              tok.isDirty = true;
            }
            foundForTarget = true;
            target._redactedInStream = true;
          }
        }
      }

      // Fallback: only match EXACT norm === normTarget (never cross-line substring .includes()!)
      if (!foundForTarget) {
        const exactMatches = tokens.filter(tok => {
          const curNorm = tok.currentDecoded ? tok.currentDecoded.replace(/\s+/g, ' ').trim() : tok.norm;
          return curNorm.length > 0 && curNorm === normTarget;
        });
        if (exactMatches.length > 0) {
          if (hasCoords) {
            exactMatches.sort((a, b) => {
              const distA = Math.hypot(a.x - rawTx, a.effY - rawTy);
              const distB = Math.hypot(b.x - rawTx, b.effY - rawTy);
              return distA - distB;
            });
            const best = exactMatches[0];
            best.currentDecoded = '';
            best.currentReplacement = best.isHex ? '<>' : '()';
            best.isDirty = true;
            target._redactedInStream = true;
          } else {
            for (const ex of exactMatches) {
              ex.currentDecoded = '';
              ex.currentReplacement = ex.isHex ? '<>' : '()';
              ex.isDirty = true;
            }
            target._redactedInStream = true;
          }
        }
      }
    }

    const dirtyTokens = tokens.filter(tok => tok.isDirty && tok.currentReplacement !== null);
    if (dirtyTokens.length === 0) return streamText;

    dirtyTokens.sort((a, b) => b.start - a.start);
    let modified = streamText;
    for (const tok of dirtyTokens) {
      modified = modified.slice(0, tok.start) + tok.currentReplacement + modified.slice(tok.end);
    }
    return modified;
  }

  // Blank out target text in decompressed content stream string (single-target convenience wrapper)
  redactTextFromStreamString(streamText, targetStr, rawTx = null, rawTy = null) {
    return this.redactMultipleTextsFromStreamString(streamText, [{ targetStr, rawTx, rawTy }]);
  }

  // Blank out vector lines from decompressed content stream string in a single pass
  redactLinesFromStreamString(streamText, linesToRedact) {
    if (!linesToRedact || linesToRedact.length === 0 || !streamText) return streamText;

    // 1. Single pass for m ... l S pattern
    const pathRegex = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+m\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+l\s+(S|s|B|B\*|f|F)\b/g;
    let modifiedText = streamText.replace(pathRegex, (full, x1Str, y1Str, x2Str, y2Str) => {
      const px1 = parseFloat(x1Str), py1 = parseFloat(y1Str);
      const px2 = parseFloat(x2Str), py2 = parseFloat(y2Str);

      for (let i = 0; i < linesToRedact.length; i++) {
        const line = linesToRedact[i];
        if (line._redactedInStream) continue;
        const rx1 = line.rawX1 !== undefined ? line.rawX1 : line.x;
        const ry1 = line.rawY1 !== undefined ? line.rawY1 : line.y;
        const rx2 = line.rawX2 !== undefined ? line.rawX2 : (line.x + (line.width || 0));
        const ry2 = line.rawY2 !== undefined ? line.rawY2 : (line.y + (line.height || 0));

        const matchForward = (Math.abs(px1 - rx1) < 2 && Math.abs(py1 - ry1) < 2 && Math.abs(px2 - rx2) < 2 && Math.abs(py2 - ry2) < 2);
        const matchReverse = (Math.abs(px1 - rx2) < 2 && Math.abs(py1 - ry2) < 2 && Math.abs(px2 - rx1) < 2 && Math.abs(py2 - ry1) < 2);
        if (matchForward || matchReverse) {
          line._redactedInStream = true;
          return ' '.repeat(full.length);
        }
      }
      return full;
    });

    // 2. Single pass for re S or re f pattern
    const reRegex = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+re\s+(S|s|B|B\*|f|F)\b/g;
    modifiedText = modifiedText.replace(reRegex, (full, rxStr, ryStr, rwStr, rhStr) => {
      const prx = parseFloat(rxStr), pry = parseFloat(ryStr);
      const prw = parseFloat(rwStr), prh = parseFloat(rhStr);

      for (let i = 0; i < linesToRedact.length; i++) {
        const line = linesToRedact[i];
        if (line._redactedInStream) continue;
        const rx1 = line.rawX1 !== undefined ? line.rawX1 : line.x;
        const ry1 = line.rawY1 !== undefined ? line.rawY1 : line.y;
        const rx2 = line.rawX2 !== undefined ? line.rawX2 : (line.x + (line.width || 0));
        const ry2 = line.rawY2 !== undefined ? line.rawY2 : (line.y + (line.height || 0));

        const minX = Math.min(rx1, rx2), maxX = Math.max(rx1, rx2);
        const minY = Math.min(ry1, ry2), maxY = Math.max(ry1, ry2);
        if (Math.abs(prx - minX) < 2 && Math.abs(prw - (maxX - minX)) < 2 && Math.abs(pry - minY) < 3.5) {
          line._redactedInStream = true;
          return ' '.repeat(full.length);
        }
      }
      return full;
    });

    return modifiedText;
  }

  // Physically remove/blank out items (texts and/or vector lines) from the PDF page in ONE single pass
  async redactItemsFromPage(displayPageIndex, { texts = [], lines = [] } = {}) {
    const pageMeta = this.pageOrder[displayPageIndex];
    if (!pageMeta || pageMeta.type === 'blank') return false;
    if ((!texts || texts.length === 0) && (!lines || lines.length === 0)) return false;

    const PDFLib = window.PDFLib;
    if (!PDFLib) return false;

    try {
      const currentBytes = this.activePdfBytes || this.originalPdfBytes;
      if (!currentBytes) return false;

      // Save to undo stack once
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

        let modifiedText = streamText;

        // 1. Redact texts in single pass
        if (texts && texts.length > 0) {
          modifiedText = this.redactMultipleTextsFromStreamString(modifiedText, texts);
        }

        // 2. Redact lines in single pass
        if (lines && lines.length > 0) {
          modifiedText = this.redactLinesFromStreamString(modifiedText, lines);
        }

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

      // Safety net: white line fallback for lines not excised in stream
      if (lines && lines.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line._redactedInStream) {
            redactedAny = true;
            const rx1 = line.rawX1 !== undefined ? line.rawX1 : line.x;
            const ry1 = line.rawY1 !== undefined ? line.rawY1 : line.y;
            const rx2 = line.rawX2 !== undefined ? line.rawX2 : (line.x + (line.width || 0));
            const ry2 = line.rawY2 !== undefined ? line.rawY2 : (line.y + (line.height || 0));
            srcPage.drawLine({
              start: { x: rx1, y: ry1 },
              end: { x: rx2, y: ry2 },
              thickness: Math.max((line.strokeWidth || 1) + 2.5, 3),
              color: PDFLib.rgb(1, 1, 1),
            });
          }
        }
      }

      // Safety net: white rectangle fallback for texts not excised in stream
      if (texts && texts.length > 0) {
        for (let i = 0; i < texts.length; i++) {
          const t = texts[i];
          if (!t._redactedInStream) {
            redactedAny = true;
            const fs = t.fontSize || t.height || 12;
            const w = t.width || (t.targetStr ? t.targetStr.length * fs * 0.6 : 50);
            const h = (t.height || fs * 1.3);

            let rx = 0;
            let ry = 0;
            if (t.rawTx !== undefined && t.rawTx !== null && t.rawTy !== undefined && t.rawTy !== null) {
              rx = t.rawTx;
              ry = t.rawTy - fs * 0.25;
            } else if (t.x !== undefined && t.y !== undefined) {
              rx = t.x;
              ry = srcPage.getHeight() - t.y - h;
            } else {
              continue;
            }

            srcPage.drawRectangle({
              x: rx - 1,
              y: ry - 1,
              width: w + 2,
              height: h + 2,
              color: PDFLib.rgb(1, 1, 1),
            });
          }
        }
      }

      if (redactedAny) {
        const newPdfBytes = await pdfDoc.save();
        this.activePdfBytes = new Uint8Array(newPdfBytes);

        // Reload PDF.js document proxy ONCE
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
      console.warn('Error during redactItemsFromPage:', e);
      return false;
    }
  }

  // Physically remove/blank out original text from the PDF content stream (delegates to redactItemsFromPage)
  async redactTextFromPage(displayPageIndex, targetStr, rawTx = null, rawTy = null) {
    return this.redactItemsFromPage(displayPageIndex, { texts: [{ targetStr, rawTx, rawTy }] });
  }

  // Physically remove/blank out vector lines from the PDF page (delegates to redactItemsFromPage)
  async redactLinesFromPage(displayPageIndex, linesToRedact) {
    return this.redactItemsFromPage(displayPageIndex, { lines: linesToRedact });
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
  async renderThumbnail(displayPageIndex, canvas, targetWidth = 140, annotationManager = null) {
    const pageSize = this.getPageSize(displayPageIndex);
    const scale = targetWidth / pageSize.width;
    const res = await this.renderPage(displayPageIndex, canvas, scale);
    if (annotationManager) {
      await this.renderAnnotationsToCanvas(displayPageIndex, canvas, scale, annotationManager);
    }
    return res;
  }

  // Render annotations onto any canvas (thumbnail or export canvas) scaled appropriately
  async renderAnnotationsToCanvas(displayPageIndex, canvas, scale = 1.0, annotationManager = null) {
    if (!annotationManager || !canvas) return;
    const annotations = annotationManager.getAnnotationsForPage(displayPageIndex);
    if (!annotations || annotations.length === 0) return;

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(scale * dpr, scale * dpr);

    // 1. Freehand & highlighters
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

    // 2. Whiteout & blackout (drawn underneath text)
    annotations.forEach(ann => {
      if (ann.type === 'whiteout') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      } else if (ann.type === 'blackout') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      }
    });

    // 3. Shapes: Rect, Circle, Line, Arrow, Checkmark, Cross
    annotations.forEach(ann => {
      if (ann.type === 'rect') {
        ctx.save();
        if (ann.fillColor && ann.fillColor !== 'transparent') {
          ctx.fillStyle = ann.fillColor;
          ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
        }
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
        ctx.restore();
      } else if (ann.type === 'circle') {
        ctx.save();
        ctx.beginPath();
        const rx = (ann.width || 0) / 2;
        const ry = (ann.height || 0) / 2;
        const cx = ann.x + rx;
        const cy = ann.y + ry;
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        if (ann.fillColor && ann.fillColor !== 'transparent') {
          ctx.fillStyle = ann.fillColor;
          ctx.fill();
        }
        ctx.strokeStyle = ann.strokeColor || '#3b82f6';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.stroke();
        ctx.restore();
      } else if (ann.type === 'line' || ann.type === 'arrow') {
        ctx.save();
        ctx.strokeStyle = ann.strokeColor || '#000000';
        ctx.lineWidth = ann.strokeWidth || 1;
        ctx.beginPath();
        const x2 = ann.x2 !== undefined ? ann.x2 : (ann.x + (ann.width || 0));
        const y2 = ann.y2 !== undefined ? ann.y2 : (ann.y + (ann.height || 0));
        ctx.moveTo(ann.x, ann.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (ann.type === 'arrow') {
          const angle = Math.atan2(y2 - ann.y, x2 - ann.x);
          const head = Math.max(8, (ann.strokeWidth || 1) * 3.5);
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }
        ctx.restore();
      } else if (ann.type === 'checkmark') {
        ctx.save();
        ctx.strokeStyle = ann.strokeColor || '#10b981';
        ctx.lineWidth = ann.strokeWidth || 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const w = ann.width || 24;
        const h = ann.height || 24;
        ctx.beginPath();
        ctx.moveTo(ann.x + w * 0.15, ann.y + h * 0.55);
        ctx.lineTo(ann.x + w * 0.42, ann.y + h * 0.85);
        ctx.lineTo(ann.x + w * 0.88, ann.y + h * 0.18);
        ctx.stroke();
        ctx.restore();
      } else if (ann.type === 'cross') {
        ctx.save();
        ctx.strokeStyle = ann.strokeColor || '#ef4444';
        ctx.lineWidth = ann.strokeWidth || 2.5;
        ctx.lineCap = 'round';
        const w = ann.width || 24;
        const h = ann.height || 24;
        ctx.beginPath();
        ctx.moveTo(ann.x + w * 0.2, ann.y + h * 0.2);
        ctx.lineTo(ann.x + w * 0.8, ann.y + h * 0.8);
        ctx.moveTo(ann.x + w * 0.8, ann.y + h * 0.2);
        ctx.lineTo(ann.x + w * 0.2, ann.y + h * 0.8);
        ctx.stroke();
        ctx.restore();
      }
    });

    // 4. Images & Signatures
    for (const ann of annotations) {
      if (ann.type === 'image' || ann.type === 'signature') {
        const src = ann.imgDataUrl || ann.dataUrl || ann.signatureData;
        if (src) {
          try {
            if (ann._cachedImg && ann._cachedImg.complete) {
              ctx.drawImage(ann._cachedImg, ann.x, ann.y, ann.width, ann.height);
            } else {
              const img = new Image();
              await new Promise(res => {
                img.onload = res;
                img.onerror = res;
                img.src = src;
              });
              ann._cachedImg = img;
              ctx.drawImage(img, ann.x, ann.y, ann.width, ann.height);
            }
          } catch (e) {}
        }
      }
    }

    // 5. Text Annotations
    for (const ann of annotations) {
      if (ann.type === 'text') {
        ctx.save();
        const rot = ((ann.rotation || 0) % 360 + 360) % 360;
        if (rot !== 0) {
          ctx.translate(ann.x, ann.y);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.translate(-ann.x, -ann.y);
        }
        if (ann.backgroundColor && ann.backgroundColor !== 'transparent') {
          ctx.fillStyle = ann.backgroundColor;
          ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
        }
        const fontFamily = ann.fontFamily || 'Helvetica';
        const fontSize = ann.fontSize || 14;
        const fontWeight = ann.fontWeight || 'normal';
        const fontStyle = ann.fontStyle || 'normal';
        ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}, sans-serif`;
        ctx.fillStyle = ann.fontColor || '#000000';

        const lines = (ann.text || '').split('\n');
        const lineHeight = fontSize * 1.25;
        let y = (ann.baselineY !== undefined && ann.baselineY !== null)
          ? ann.baselineY
          : (ann.y + fontSize * 0.88);
        for (const line of lines) {
          ctx.fillText(line, ann.x, y);
          y += lineHeight;
        }
        ctx.restore();
      }
    }

    ctx.restore();
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

  // Export full modified PDF (or subset of pages specified by pageIndices)
  async exportPDF(annotationManager, customFilename = null, pageIndices = null) {
    if (!window.PDFLib) {
      throw new Error('PDF-Lib library is not available');
    }

    const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
    let outDoc = null;

    // Ensure Thai TrueType CMap patching is active in PDFLib
    if (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.patchPdfLib) {
      window.ThaiSupport.patchPdfLib(window.PDFLib);
    }

    const srcBytes = this.activePdfBytes || this.originalPdfBytes;
    if (srcBytes && srcBytes.length > 0) {
      const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
      outDoc = await PDFDocument.create();

      // Register fontkit if available
      if (typeof window !== 'undefined' && window.fontkit && typeof outDoc.registerFontkit === 'function') {
        outDoc.registerFontkit(window.fontkit);
      }

      // Copy standard fonts
      const fontHelvetica = await outDoc.embedFont(StandardFonts.Helvetica);
      const fontHelveticaBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const fontTimes = await outDoc.embedFont(StandardFonts.TimesRoman);
      const fontTimesBold = await outDoc.embedFont(StandardFonts.TimesRomanBold);
      const fontCourier = await outDoc.embedFont(StandardFonts.Courier);
      const fontCourierBold = await outDoc.embedFont(StandardFonts.CourierBold);

      let fontSarabun = null;
      let fontSarabunBold = null;
      const ensureSarabunFont = async (isBold) => {
        if (typeof window === 'undefined' || !window.ThaiSupport || !window.ThaiSupport.getSarabunBytes) {
          return isBold ? fontHelveticaBold : fontHelvetica;
        }
        try {
          if (isBold) {
            if (!fontSarabunBold) {
              const bytes = window.ThaiSupport.getSarabunBytes(true);
              if (bytes) {
                fontSarabunBold = await outDoc.embedFont(bytes, { subset: false });
              } else {
                return fontHelveticaBold;
              }
            }
            return fontSarabunBold;
          } else {
            if (!fontSarabun) {
              const bytes = window.ThaiSupport.getSarabunBytes(false);
              if (bytes) {
                fontSarabun = await outDoc.embedFont(bytes, { subset: false });
              } else {
                return fontHelvetica;
              }
            }
            return fontSarabun;
          }
        } catch (err) {
          console.warn('Failed to embed Sarabun font:', err);
          return isBold ? fontHelveticaBold : fontHelvetica;
        }
      };

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

      // Process each page according to pageOrder or specified pageIndices
      const targetIndices = (Array.isArray(pageIndices) && pageIndices.length > 0)
        ? pageIndices
        : Array.from({ length: this.pageOrder.length }, (_, k) => k);

      for (const displayIdx of targetIndices) {
        if (displayIdx < 0 || displayIdx >= this.pageOrder.length) continue;
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
        let pageAnnotations = annotationManager.getAnnotationsForPage(displayIdx);

        // If page has a user rotation, un-rotate annotations into the unrotated (0°) page coordinate system
        // because PDF-Lib targetPage.draw* operates in the unrotated page coordinate space
        if (userRot !== 0 && pageAnnotations.length > 0) {
          pageAnnotations = JSON.parse(JSON.stringify(pageAnnotations));
          const unrotDegrees = ((360 - (userRot % 360)) % 360);
          const steps = unrotDegrees / 90;
          let curW = (userRot % 180 !== 0) ? pageHeight : pageWidth;
          let curH = (userRot % 180 !== 0) ? pageWidth : pageHeight;

          for (let s = 0; s < steps; s++) {
            for (const ann of pageAnnotations) {
              if (ann.type === 'text') {
                const nx = +(curH - ann.y).toFixed(2);
                const ny = +(ann.x).toFixed(2);
                ann.x = nx;
                ann.y = ny;
                ann.rotation = (((ann.rotation || 0) + 90) % 360);
                if (ann.baselineY !== undefined && ann.baselineY !== null) {
                  ann.baselineY = null;
                }
              } else if (ann.type === 'line' || ann.type === 'arrow') {
                const x1 = ann.x;
                const y1 = ann.y;
                const x2 = ann.x + (ann.width || 0);
                const y2 = ann.y + (ann.height || 0);
                const nx1 = +(curH - y1).toFixed(2);
                const ny1 = +(x1).toFixed(2);
                const nx2 = +(curH - y2).toFixed(2);
                const ny2 = +(x2).toFixed(2);
                ann.x = nx1;
                ann.y = ny1;
                ann.width = +((nx2 - nx1).toFixed(2));
                ann.height = +((ny2 - ny1).toFixed(2));
              } else if (ann.type === 'freehand' || ann.type === 'highlighter') {
                if (Array.isArray(ann.points)) {
                  ann.points = ann.points.map(p => ({
                    x: +(curH - p.y).toFixed(2),
                    y: +(p.x).toFixed(2)
                  }));
                }
                const nx = +(curH - (ann.y + (ann.height || 0))).toFixed(2);
                const ny = +(ann.x).toFixed(2);
                const nw = ann.height || 0;
                const nh = ann.width || 0;
                ann.x = nx; ann.y = ny; ann.width = nw; ann.height = nh;
              } else {
                const nx = +(curH - (ann.y + (ann.height || 0))).toFixed(2);
                const ny = +(ann.x).toFixed(2);
                const nw = ann.height || 0;
                const nh = ann.width || 0;
                ann.x = nx; ann.y = ny; ann.width = nw; ann.height = nh;
                ann.rotation = (((ann.rotation || 0) + 90) % 360);
              }
            }
            const temp = curW;
            curW = curH;
            curH = temp;
          }
        }

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
            const rawText = ann.text || '';
            const normText = (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.normalizeThaiText)
              ? window.ThaiSupport.normalizeThaiText(rawText)
              : rawText;

            const isBold = ann.fontWeight === 'bold';
            const isThaiOrUnicode = (ann.fontFamily === 'Sarabun') ||
              (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.isThaiFontName && window.ThaiSupport.isThaiFontName(ann.fontFamily)) ||
              (typeof window !== 'undefined' && window.ThaiSupport && window.ThaiSupport.containsNonWinAnsi ? window.ThaiSupport.containsNonWinAnsi(normText) : /[^\x00-\xFF]/.test(normText));

            let font = isThaiOrUnicode
              ? await ensureSarabunFont(isBold)
              : getFont(ann.fontFamily, ann.fontWeight);

            const fontSize = ann.fontSize || 14;
            const textColor = this.hexToPdfRgb(ann.fontColor || '#000000');
            const lines = normText.split('\n');

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
                const drawOpts = {
                  x: ann.x,
                  y: currentLineY,
                  size: fontSize,
                  font: font,
                  color: textColor,
                };
                if (ann.rotation) {
                  drawOpts.rotate = degrees(ann.rotation);
                }
                try {
                  targetPage.drawText(line, drawOpts);
                } catch (err) {
                  // Fallback to Sarabun if standard font throws encoding error
                  try {
                    const fallbackFont = await ensureSarabunFont(isBold);
                    const fallbackOpts = Object.assign({}, drawOpts, { font: fallbackFont });
                    targetPage.drawText(line, fallbackOpts);
                  } catch (fallbackErr) {
                    console.warn('Failed to draw text line in PDF export:', fallbackErr);
                  }
                }
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

    exportedBytes.bytes = exportedBytes;
    exportedBytes.size = exportedBytes.length;
    exportedBytes.filename = finalFilename;

    return exportedBytes;
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
    if (annotationManager) {
      await this.renderAnnotationsToCanvas(displayPageIndex, combinedCanvas, scale, annotationManager);
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
