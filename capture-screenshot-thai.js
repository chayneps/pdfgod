const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function captureThaiScreenshot() {
  console.log('--- Capturing Screenshot #9: Thai Language Support ---');

  const PORT = 26500 + Math.floor(Math.random() * 2000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-thai-ss-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    let targets = null;
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) throw new Error('Could not connect to Chrome on port ' + PORT);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise(resolve => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    });

    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        console.error('Evaluate Exception:', r.exceptionDetails);
        throw new Error(JSON.stringify(r.exceptionDetails));
      }
      return r.result ? r.result.value : undefined;
    };

    console.log('1. Generating 2-Page Thai Invoice PDF in browser with updated Sarabun fonts & zero mark gaps...');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      while (!window.uiController || !window.pdfEngine || !window.ThaiSupport) await sleep(50);
      await window.ThaiSupport.ensureBrowserFontsLoaded();

      const doc = await PDFLib.PDFDocument.create();
      doc.registerFontkit(window.fontkit);

      const sarabunRegBytes = window.ThaiSupport.getSarabunBytes(false);
      const sarabunBoldBytes = window.ThaiSupport.getSarabunBytes(true);

      const fontReg = await doc.embedFont(sarabunRegBytes, { subset: false });
      const fontBold = await doc.embedFont(sarabunBoldBytes, { subset: false });

      const PAGE_W = 595.28;
      const PAGE_H = 841.89;

      for (let p = 0; p < 2; p++) {
        const page = doc.addPage([PAGE_W, PAGE_H]);

        // Title Header (Right aligned box, clean layout within margins)
        page.drawText('ใบส่งของ / ใบกำกับภาษี', { x: 375, y: 800, size: 15, font: fontBold, color: PDFLib.rgb(0.12, 0.22, 0.45) });
        page.drawText('DELIVERY SLIP / TAX INVOICE', { x: 375, y: 785, size: 9, font: fontBold, color: PDFLib.rgb(0.4, 0.45, 0.55) });
        page.drawText('ต้นฉบับ (ORIGINAL)', { x: 375, y: 770, size: 9, font: fontReg, color: PDFLib.rgb(0.3, 0.3, 0.3) });

        // Company Header (Left)
        page.drawText('บริษัท สยามโกลบอล โลจิสติกส์ จำกัด (มหาชน)', { x: 45, y: 800, size: 14, font: fontBold, color: PDFLib.rgb(0.08, 0.15, 0.3) });
        page.drawText('123 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110', { x: 45, y: 782, size: 9.5, font: fontReg, color: PDFLib.rgb(0.2, 0.2, 0.2) });
        page.drawText('โทร. 02-123-4567   เลขประจำตัวผู้เสียภาษี 0107555000123 (สำนักงานใหญ่)', { x: 45, y: 766, size: 9.5, font: fontReg, color: PDFLib.rgb(0.2, 0.2, 0.2) });

        // Divider
        page.drawLine({ start: { x: 45, y: 752 }, end: { x: 550, y: 752 }, thickness: 1, color: PDFLib.rgb(0.8, 0.85, 0.9) });

        // Customer Details Box (Left)
        page.drawText('ลูกค้า / Customer:', { x: 45, y: 736, size: 10, font: fontBold, color: PDFLib.rgb(0.15, 0.2, 0.3) });
        page.drawText('บริษัท ซันไชน์ เทรดดิ้ง แอนด์ ทรานสปอร์ต จำกัด', { x: 135, y: 736, size: 10, font: fontBold });
        page.drawText('88/9 หมู่ 5 ถนนบางนา-ตราด กม.18 บางพลี สมุทรปราการ 10540', { x: 135, y: 720, size: 9, font: fontReg });
        page.drawText('เลขประจำตัวผู้เสียภาษี 0105558000456', { x: 135, y: 706, size: 9, font: fontReg });

        // Invoice Meta (Right, with clean aligned spacing)
        page.drawText('เลขที่ / No:', { x: 395, y: 736, size: 9, font: fontReg });
        page.drawText('INV-2569/10-089', { x: 460, y: 736, size: 9, font: fontBold });
        page.drawText('วันที่ / Date:', { x: 395, y: 720, size: 9, font: fontReg });
        page.drawText('20 ตุลาคม 2569', { x: 460, y: 720, size: 9, font: fontBold });
        page.drawText('หน้า / Page:', { x: 395, y: 706, size: 9, font: fontReg });
        page.drawText((p + 1) + ' / 2', { x: 460, y: 706, size: 9, font: fontBold });

        // Table Coordinates
        const tTop = 680;
        const tHeaderBtm = 656;
        const tBtm = 530;
        const cols = [45, 80, 310, 375, 460, 550];

        // Table Background Header
        page.drawRectangle({
          x: 45, y: tHeaderBtm, width: 505, height: tTop - tHeaderBtm,
          color: PDFLib.rgb(0.93, 0.96, 0.99)
        });

        // Table Borders (Outer & Header)
        page.drawLine({ start: { x: 45, y: tTop }, end: { x: 550, y: tTop }, thickness: 1, color: PDFLib.rgb(0.3, 0.45, 0.7) });
        page.drawLine({ start: { x: 45, y: tHeaderBtm }, end: { x: 550, y: tHeaderBtm }, thickness: 1, color: PDFLib.rgb(0.3, 0.45, 0.7) });
        page.drawLine({ start: { x: 45, y: tBtm }, end: { x: 550, y: tBtm }, thickness: 1, color: PDFLib.rgb(0.3, 0.45, 0.7) });

        // Vertical lines
        for (const cx of cols) {
          page.drawLine({ start: { x: cx, y: tTop }, end: { x: cx, y: tBtm }, thickness: 0.75, color: PDFLib.rgb(0.7, 0.75, 0.85) });
        }

        // Table Headers
        page.drawText('ลำดับ', { x: 52, y: 664, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });
        page.drawText('รายการสินค้า / รายละเอียด', { x: 90, y: 664, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });
        page.drawText('จำนวน', { x: 325, y: 664, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });
        page.drawText('ราคาต่อหน่วย', { x: 390, y: 664, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });
        page.drawText('จำนวนเงิน (บาท)', { x: 472, y: 664, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });

        // Table Rows with Thai Stacked Vowels & Tone Marks
        const items = [
          ['1', 'ข้าวหอมมะลิคัดพิเศษ 100% (ถุง 5 กก.)', '20 ถุง', '350.00', '7,000.00'],
          ['2', 'น้ำดื่มบริสุทธิ์แพ็คคู่ (ขนาด 1,500 มล.)', '50 แพ็ค', '120.00', '6,000.00'],
          ['3', 'ปั้นจั่นยกสินค้าอุตสาหกรรมขนาด 2 ตัน', '1 เครื่อง', '45,000.00', '45,000.00'],
          ['4', 'เก้าอี้สำนักงานเพื่อสุขภาพ เบาะรองหลังปรับระดับ', '8 ตัว', '3,200.00', '25,600.00']
        ];

        let rowY = 635;
        for (const it of items) {
          page.drawText(it[0], { x: 58, y: rowY, size: 9.5, font: fontReg });
          page.drawText(it[1], { x: 90, y: rowY, size: 9.5, font: fontReg });
          page.drawText(it[2], { x: 325, y: rowY, size: 9.5, font: fontReg });
          page.drawText(it[3], { x: 405, y: rowY, size: 9.5, font: fontReg });
          page.drawText(it[4], { x: 495, y: rowY, size: 9.5, font: fontBold });

          // Row separator line
          page.drawLine({ start: { x: 45, y: rowY - 7 }, end: { x: 550, y: rowY - 7 }, thickness: 0.5, color: PDFLib.rgb(0.88, 0.9, 0.94) });
          rowY -= 25;
        }

        // Summary box
        page.drawText('รวมเงินทั้งสิ้น / TOTAL:', { x: 360, y: 512, size: 10, font: fontBold, color: PDFLib.rgb(0.1, 0.2, 0.4) });
        page.drawText('83,600.00 บาท', { x: 478, y: 512, size: 11, font: fontBold, color: PDFLib.rgb(0.08, 0.35, 0.7) });
      }

      const pdfBytes = await doc.save();
      await window.uiController.loadPdfBuffer(pdfBytes.buffer.slice(0), "ใบส่งของ_ใบกำกับภาษี_สยามโกลบอล.pdf");
      await sleep(300);
    `);

    console.log('2. Activating edit-pdf-text mode and selecting Thai text...');
    await evaluate(`
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      window._clickText = async (targetStr, pageIndex = 0, isShift = false) => {
        const items = await window.pdfEngine.getTextItems(pageIndex);
        const item = items.find(it => it.str.includes(targetStr));
        if (!item) throw new Error('Text item not found: ' + targetStr);
        const layer = document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"] .annotation-layer') ||
                      document.querySelector('.page-wrapper[data-page-index="' + pageIndex + '"]');
        const rect = layer.getBoundingClientRect();
        const zoom = window.uiController.zoom || 1;
        const clickX = rect.left + (item.x + 15) * zoom;
        const clickY = rect.top + (item.y + 5) * zoom;

        layer.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY, shiftKey: isShift
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, button: 0, clientX: clickX, clientY: clickY, shiftKey: isShift
        }));
        await sleep(150);
      };

      // Click edit-pdf-text tool
      document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
      await sleep(200);

      // In-place click on Company Header to trigger stream redaction and spawn replacement Sarabun box
      await window._clickText('บริษัท สยามโกลบอล โลจิสติกส์ จำกัด (มหาชน)', 0, false);
      await sleep(200);

      // Shift-click line 2
      await window._clickText('123 ถนนสุขุมวิท', 0, true);
      // Shift-click line 3
      await window._clickText('โทร. 02-123-4567', 0, true);
      await sleep(200);

      // Click "Match Across Pages" button to open the batch group widget
      const matchBtn = document.getElementById('prop-match-pages-btn');
      if (matchBtn) matchBtn.click();
      await sleep(300);

      // Add a Buddhist Era date stamp annotation on Page 1
      window.annotationManager.addAnnotation({
        type: 'text',
        text: '📅 วันที่อนุมัติ: 20 ต.ค. 2569 (ฝ่ายบัญชี)',
        fontFamily: 'Sarabun',
        fontSize: 10,
        fontWeight: 'bold',
        fontColor: '#1d4ed8',
        backgroundColor: '#eff6ff',
        x: 45,
        y: 350,
        width: 220,
        height: 24,
        pageIndex: 0
      });

      window.canvasController.render();
      window.uiController.updatePropertiesBar();
      await sleep(300);
    `);

    console.log('3. Capturing high-resolution viewport screenshot...');
    const screenshotRes = await send('Page.captureScreenshot', {
      format: 'png',
      quality: 100
    });

    const screenshotPath = path.resolve(__dirname, 'docs/screenshots/09-thai-language-support.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'));
    console.log(`🎉 Screenshot captured successfully: ${screenshotPath} (${(fs.statSync(screenshotPath).size / 1024).toFixed(1)} KB)`);

  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

captureThaiScreenshot().catch(err => {
  console.error('Error capturing screenshot:', err);
  process.exit(1);
});
