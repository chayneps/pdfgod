const fs = require('fs');
const path = require('path');

const APP_VERSION = 17;

function bundle() {
  console.log(`Compiling single-file HTML application (v${APP_VERSION})...`);

  const outputPath = path.join(__dirname, 'pdfgod.html');

  // If an existing pdfgod.html has an older version badge, archive it to pdfgod_v<old>.html automatically
  if (fs.existsSync(outputPath)) {
    try {
      const prevHtml = fs.readFileSync(outputPath, 'utf8');
      const match = prevHtml.match(/id="app-version-badge"[^>]*>v?(\d+)<\/span>/i);
      if (match) {
        const oldVer = parseInt(match[1], 10);
        if (oldVer > 0 && oldVer < APP_VERSION) {
          const archivePath = path.join(__dirname, `pdfgod_v${oldVer}.html`);
          if (!fs.existsSync(archivePath)) {
            fs.copyFileSync(outputPath, archivePath);
            console.log(`📦 Archived previous version v${oldVer} to: ${archivePath}`);
          }
        }
      }
    } catch (e) {
      console.warn('Could not check/archive previous version:', e.message);
    }
  }

  // 1. Read CSS files
  const cssFiles = [
    'css/main.css',
    'css/toolbar.css',
    'css/sidebar.css',
    'css/canvas.css',
    'css/modals.css',
  ];

  let combinedCss = '';
  for (const f of cssFiles) {
    console.log(`- Inlining CSS: ${f}`);
    combinedCss += `\n/* --- ${f} --- */\n` + fs.readFileSync(path.join(__dirname, f), 'utf8');
  }

  // 2. Read JS files
  const jsFiles = [
    'vendor/pdf.min.js',
    'vendor/pdf-lib.min.js',
    'vendor/pdf-lib-encrypt.js',
    'vendor/fontkit.umd.min.js',
    'js/thai-support.js',
    'js/annotation-manager.js',
    'js/pdf-engine.js',
    'js/excel-exporter.js',
    'js/canvas-controller.js',
    'js/signature-pad.js',
    'js/ui-controller.js',
    'js/app.js',
  ];

  const workerCode = fs.readFileSync(path.join(__dirname, 'vendor', 'pdf.worker.min.js'), 'utf8');

  let combinedJs = `\nwindow.PDFGOD_VERSION = ${APP_VERSION};\n`;
  for (const f of jsFiles) {
    console.log(`- Inlining JS: ${f}`);
    combinedJs += `\n// --- ${f} ---\n` + fs.readFileSync(path.join(__dirname, f), 'utf8') + '\n;';
  }

  // 3. Read base HTML template
  const rawHtml = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

  // Strip external CSS links if any
  let html = rawHtml.replace(/<link\s+rel="stylesheet"\s+href="[^"]*">/gi, '');

  // Strip external script tags at bottom
  html = html.replace(/<!-- Vendor Scripts.*?<\/script>\s*<!-- Application Modules -->.*?<\/body>/is, '</body>');

  // Inject CSS into <head>
  const styleTag = `\n  <style>\n${combinedCss}\n  </style>\n</head>`;
  html = html.replace('</head>', () => styleTag);

  // Inject Worker script and combined JS before </body>
  const scriptsToInject = `
  <!-- Embedded PDF Worker Script -->
  <script type="text/javascript-worker" id="pdf-worker-code">
${workerCode.replace(/<\/script>/gi, '<\\/script>')}
  </script>

  <!-- Embedded All-In-One Application & Vendor Scripts -->
  <script>
${combinedJs.replace(/<\/script>/gi, '<\\/script>')}
  </script>
</body>`;

  html = html.replace('</body>', () => scriptsToInject);

  // Write to pdfgod.html
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`\n🎉 Success! Single-file HTML (v${APP_VERSION}) generated at: ${outputPath}`);
  console.log(`Total file size: ${(fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2)} MB`);

  // Copy full application to index.html for direct GitHub Pages serving (no redirects)
  const indexOutputPath = path.join(__dirname, 'index.html');
  fs.copyFileSync(outputPath, indexOutputPath);
  console.log(`Copied full application to index.html for direct GitHub Pages serving.`);
}

bundle();
