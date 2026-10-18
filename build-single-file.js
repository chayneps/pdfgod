const fs = require('fs');
const path = require('path');

function bundle() {
  console.log('Compiling single-file HTML application...');

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
    'js/annotation-manager.js',
    'js/pdf-engine.js',
    'js/excel-exporter.js',
    'js/canvas-controller.js',
    'js/signature-pad.js',
    'js/ui-controller.js',
    'js/app.js',
  ];

  const workerCode = fs.readFileSync(path.join(__dirname, 'vendor', 'pdf.worker.min.js'), 'utf8');

  let combinedJs = '';
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
  const outputPath = path.join(__dirname, 'pdfgod.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`\n🎉 Success! Single-file HTML generated at: ${outputPath}`);
  console.log(`Total file size: ${(fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2)} MB`);

  // Ensure index.html exists as a lightweight GitHub Pages redirect
  const indexOutputPath = path.join(__dirname, 'index.html');
  const redirectHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=pdfgod.html">
  <title>PDFGod — In-Browser PDF Editor</title>
  <script>window.location.replace("pdfgod.html" + window.location.search + window.location.hash);</script>
</head>
<body>
  <p>Loading PDFGod... If you are not redirected automatically, <a href="pdfgod.html">click here to open PDFGod</a>.</p>
</body>
</html>\n`;
  fs.writeFileSync(indexOutputPath, redirectHtml, 'utf8');
  console.log(`Verified GitHub Pages redirect at: ${indexOutputPath}`);
}

bundle();
