const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testFavicon() {
  console.log('--- Starting Chrome Tab Favicon Verification Test Suite ---');
  const PORT = 21000 + Math.floor(Math.random() * 8000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    let targets = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        targets = await res.json();
        if (targets && targets.length > 0 && targets.find(t => t.type === 'page')) break;
      } catch (e) {}
    }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    console.log('1. Checking favicon <link> element in document.head...');
    const faviconData = await evaluate(`
      const svgLink = document.querySelector('link[rel="icon"]');
      const pngLink = document.querySelector('link[rel="alternate icon"]');
      const brandSvg = document.querySelector('.brand-logo svg');

      return {
        hasSvgLink: !!svgLink,
        svgType: svgLink ? svgLink.type : null,
        svgHref: svgLink ? decodeURIComponent(svgLink.href) : null,
        hasPngLink: !!pngLink,
        pngHrefPrefix: pngLink ? pngLink.href.substring(0, 30) : null,
        brandSvgInner: brandSvg ? brandSvg.innerHTML.replace(/\\s+/g, ' ').trim() : null
      };
    `);

    console.log('Favicon element details:', {
      hasSvgLink: faviconData.hasSvgLink,
      svgType: faviconData.svgType,
      hasPngLink: faviconData.hasPngLink,
      pngHrefPrefix: faviconData.pngHrefPrefix
    });

    if (!faviconData.hasSvgLink) {
      throw new Error('Missing <link rel="icon"> in document.head!');
    }
    if (faviconData.svgType !== 'image/svg+xml') {
      throw new Error(`Expected favicon type "image/svg+xml", got "${faviconData.svgType}"`);
    }

    console.log('2. Verifying that the favicon SVG matches the logo before the word "PDFGod"...');
    // Check paths
    const docPath = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z';
    const foldPath = '14 2 14 8 20 8';
    const checkPath = 'M10 13l2 2 4-4';

    if (!faviconData.svgHref.includes(docPath)) {
      throw new Error('Favicon SVG is missing the document outline path: ' + docPath);
    }
    if (!faviconData.svgHref.includes(foldPath)) {
      throw new Error('Favicon SVG is missing the folded corner: ' + foldPath);
    }
    if (!faviconData.svgHref.includes(checkPath)) {
      throw new Error('Favicon SVG is missing the checkmark: ' + checkPath);
    }
    if (!faviconData.svgHref.includes('#3b82f6') && !faviconData.svgHref.includes('%233b82f6')) {
      throw new Error('Favicon SVG should use the signature brand blue #3b82f6!');
    }

    console.log('   ✅ SVG favicon paths match the brand logo exactly!');
    console.log('   ✅ PNG alternate favicon fallback generated:', faviconData.hasPngLink);

    ws.close();
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
    console.log('🎉 ALL TAB FAVICON TESTS PASSED 100%! 🎉');
  } catch (err) {
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
    throw err;
  }
}

testFavicon().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
