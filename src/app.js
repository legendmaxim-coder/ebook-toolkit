// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileInput      = document.getElementById('fileInput');
const mergeBtn       = document.getElementById('mergeBtn');
const exportEpubBtn  = document.getElementById('exportEpubBtn');
const logEl          = document.getElementById('log');
const filesListEl    = document.getElementById('filesList');
const dropZone       = document.getElementById('dropZone');
const filesSection   = document.getElementById('filesSection');
const actionsSection = document.getElementById('actionsSection');
const logSection     = document.getElementById('logSection');
const fileCountEl    = document.getElementById('fileCount');
const statusText     = document.getElementById('statusText');
const clearLogBtn    = document.getElementById('clearLogBtn');
const badgeDot       = document.querySelector('.badge-dot');

let loadedFb2s = []; // {name, xml, binaries: Map, cover?}

// ── Coloured log ──────────────────────────────────────────────────────────────
function log(msg, level = 'plain'){
  logSection.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  const now = new Date();
  ts.textContent = now.toLocaleTimeString('ru',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const txt = document.createElement('span');
  // auto-detect level from first char
  if(level === 'plain'){
    if(msg.startsWith('✓') || msg.startsWith('✅')) level = 'ok';
    else if(msg.startsWith('⚠')) level = 'warn';
    else if(msg.startsWith('✗') || msg.startsWith('❌')) level = 'err';
    else if(msg.startsWith('ℹ') || msg.startsWith('→')) level = 'info';
  }
  txt.className = 'log-' + level;
  txt.textContent = msg;
  line.appendChild(ts);
  line.appendChild(txt);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, busy = false){
  statusText.textContent = text;
  badgeDot.classList.toggle('busy', busy);
}

clearLogBtn.addEventListener('click', () => {
  logEl.innerHTML = '';
  logSection.classList.add('hidden');
});

// ── Drag-and-drop ─────────────────────────────────────────────────────────────
dropZone.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' || e.key === ' ') fileInput.click();
});
['dragenter','dragover'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});
['dragleave','dragend'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'));
});
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files || []);
  if(files.length) await loadFiles(files);
});

fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if(files.length) await loadFiles(files);
});

async function loadFiles(files){
  loadedFb2s = [];
  setStatus('Загрузка...', true);
  exportEpubBtn.disabled = true;
  for(const f of files){
    try{
      await processFile(f);
    }catch(err){
      console.error(err);
      log('✗ Ошибка: ' + f.name + ' — ' + (err.message || err));
    }
  }
  log('ℹ Загружено книг: ' + loadedFb2s.length);
  setStatus('Готов');
  renderFilesList();
}

async function processFile(file){
  const name = file.name.toLowerCase();
  if(name.endsWith('.zip')){
    const data = await file.arrayBuffer();
    const z = await JSZip.loadAsync(data);
    const entries = Object.keys(z.files);
    const fb2Files = entries.filter(p=>p.toLowerCase().endsWith('.fb2'));
    for(const p of fb2Files){
      const txt = await z.file(p).async('text');
      const item = extractBinariesAndCover(txt, p);
      loadedFb2s.push(item);
      log('✓ Из zip (FB2):', p);
    }
    const epubFiles = entries.filter(p=>p.toLowerCase().endsWith('.epub'));
    for(const p of epubFiles){
      const arr = await z.file(p).async('arraybuffer');
      const item = await processEpubArrayBuffer(arr, p);
      loadedFb2s.push(item);
      log('✓ Из zip (EPUB):', p);
    }
    const mobiFiles = entries.filter(p=>p.toLowerCase().endsWith('.mobi'));
    for(const p of mobiFiles){
      try{
        const arr = await z.file(p).async('arraybuffer');
        const item = await processMobiArrayBuffer(arr, p);
        loadedFb2s.push(item);
        log('✓ Из zip (MOBI):', p);
      }catch(err){ log('✗ MOBI из zip:', p, '—', err.message||err); }
    }
  } else if(name.endsWith('.fb2')){
    const txt = await file.text();
    const item = extractBinariesAndCover(txt, file.name);
    loadedFb2s.push(item);
    log('✓ Загружен FB2:', file.name);
  } else if(name.endsWith('.epub')){
    const arr = await file.arrayBuffer();
    const item = await processEpubArrayBuffer(arr, file.name);
    loadedFb2s.push(item);
    log('✓ Загружен EPUB:', file.name);
  } else if(name.endsWith('.mobi')){
    const arr = await file.arrayBuffer();
    const item = await processMobiArrayBuffer(arr, file.name);
    loadedFb2s.push(item);
    log('✓ Загружен MOBI:', file.name);
  } else if(name.endsWith('.html')||name.endsWith('.htm')||name.endsWith('.txt')){
    const txt = await file.text();
    const wrapped = `<?xml version="1.0"?><FictionBook><body>${txt}</body></FictionBook>`;
    loadedFb2s.push({name:file.name, xml:wrapped, binaries:new Map(), cover:null});
    log('✓ Загружен (HTML/TXT):', file.name);
  } else {
    log('✗ Пропущен файл (формат не поддерживается):', file.name);
  }
}

async function processEpubArrayBuffer(arrayBuffer, name){
  const z = await JSZip.loadAsync(arrayBuffer);
  const entries = Object.keys(z.files);
  const xhtmlFiles = entries.filter(p=>/\.(xhtml|html|htm)$/i.test(p) && !p.toLowerCase().startsWith('meta-inf/'));
  let bodies = [];
  let title = name;
  let cover = null;
  for(const p of xhtmlFiles){
    try{
      const txt = await z.file(p).async('text');
      const doc = new DOMParser().parseFromString(txt,'application/xml');
      const titleEl = doc.querySelector('title');
      if(titleEl) title = titleEl.textContent.trim();
      const body = doc.querySelector('body');
      if(body){
        let s='';
        for(const ch of body.childNodes) s += new XMLSerializer().serializeToString(ch);
        bodies.push(s);
      } else {
        bodies.push(txt);
      }
      if(!cover){
        const img = doc.querySelector('img');
        if(img){
          const src = img.getAttribute('src');
          if(src){
            const imgName = src.split('/').pop().split('?')[0];
            const match = entries.find(k=>k.toLowerCase().endsWith('/'+imgName) || k.toLowerCase()===imgName.toLowerCase());
            if(match){
              const arr = await z.file(match).async('arraybuffer');
              const ext = (imgName.split('.').pop()||'jpg').toLowerCase();
              const mime = ext==='png'?'image/png':'image/jpeg';
              cover = {blob:new Blob([arr],{type:mime}), filename: name.replace(/\.[^.]+$/,'')+'_cover.'+ext, type:mime};
            }
          }
        }
      }
    }catch(e){ continue; }
  }
  const bodyCombined = bodies.join('');
  const xml = `<?xml version="1.0"?><FictionBook><description><title-info><book-title>${escapeXml(title)}</book-title></title-info></description><body>${bodyCombined}</body></FictionBook>`;
  return {name, xml, binaries:new Map(), cover};
}

function extractBinariesAndCover(xmlText, name){
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const binaries = new Map();
  for(const b of Array.from(doc.getElementsByTagName('binary'))){
    const id = b.getAttribute('id') || b.getAttribute('xml:id');
    const contentType = b.getAttribute('content-type') || b.getAttribute('contentType') || 'image/jpeg';
    const data = (b.textContent || '').trim();
    if(id && data){ binaries.set(id, {contentType, data}); }
  }
  // find cover reference
  let coverHref = null;
  const coverImg = doc.querySelector('coverpage image') || doc.querySelector('coverpage > * image');
  if(coverImg){
    coverHref = coverImg.getAttribute('l:href') || coverImg.getAttribute('xlink:href') || coverImg.getAttribute('href');
  }
  let cover = null;
  if(coverHref && coverHref.startsWith('#')){
    const id = coverHref.slice(1);
    const bin = binaries.get(id);
    if(bin){
      const blob = base64ToBlob(bin.data, bin.contentType);
      const ext = mimeToExt(bin.contentType);
      cover = {blob, filename: (name.replace(/\.[^.]+$/, '') + '_cover.' + ext), type: bin.contentType};
    }
  }
  return {name, xml: xmlText, binaries, cover};
}

function mimeToExt(mime){
  if(!mime) return 'img';
  if(mime.includes('jpeg')||mime.includes('jpg')) return 'jpg';
  if(mime.includes('png')) return 'png';
  if(mime.includes('gif')) return 'gif';
  return 'img';
}

function base64ToBlob(base64, contentType){
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes], {type: contentType});
}

function parseFB2(xmlText){
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  // FB2 title is in <description><title-info><book-title>
  // querySelector may fail with namespaced XML, so use multiple fallbacks
    let titleEl = doc.querySelector('description > title-info > book-title')
              || doc.querySelector('title-info > book-title')
              || doc.querySelector('book-title');
  if (!titleEl) {
    const els = doc.getElementsByTagName('book-title');
    if (els.length > 0) titleEl = els[0];
  }
  if (!titleEl) {
    // fallback for document-title (used by alternative FB2 styles)
    const dtEl = doc.querySelector('document-title');
    if (dtEl) titleEl = dtEl;
  }
  if (!titleEl) {
    // try generic title element (avoid section titles)
    const titleEls = doc.getElementsByTagName('title');
    for (const t of titleEls) {
      const parent = t.parentElement;
      if (parent && (parent.tagName === 'SECTION' || parent.tagName === 'BODY' && !t.querySelector('p'))) continue;
      titleEl = t;
      break;
    }
  }
  const title = titleEl ? titleEl.textContent.trim() : 'Untitled';
  
  // extract body and sections
  const bodies = Array.from(doc.querySelectorAll('body')).map(body=>{
    const sections = Array.from(body.querySelectorAll(':scope > section'));
    if(sections.length > 0){
      // has sections - extract each with title
      return sections.map((sec, idx)=>{
        const secTitle = sec.querySelector(':scope > title');
        const titleText = secTitle ? secTitle.textContent.trim() : `Раздел ${idx+1}`;
        let html = '';
        for(const ch of sec.childNodes){
          if(ch !== secTitle) html += new XMLSerializer().serializeToString(ch);
        }
        return {title: titleText, html};
      });
    } else {
      // no sections - treat whole body as one
      let s = '';
      for(const ch of body.childNodes) s += new XMLSerializer().serializeToString(ch);
      return [{title: 'Содержание', html: s}];
    }
  }).flat();
  
  return {title, bodies, doc};
}

function buildMergedFB2(items){
  if(!items.length) return null;
  const firstDoc = parseFB2(items[0].xml).doc;
  // create new FB2 document copying header and description
  const fb2 = firstDoc.cloneNode(true);
  const bodies = fb2.querySelectorAll('body');
  bodies.forEach(b=>b.remove());

  const newBody = fb2.createElement('body');
  for(const it of items){
    const parsed = parseFB2(it.xml);
    for(const bHtml of parsed.bodies){
      const fragDoc = new DOMParser().parseFromString('<root>'+bHtml+'</root>','application/xml');
      const root = fragDoc.documentElement;
      for(const n of Array.from(root.childNodes)){
        newBody.appendChild(fb2.importNode(n, true));
      }
    }
  }
  // append new body
  const bodyParent = fb2.getElementsByTagName('FictionBook')[0] || fb2;
  bodyParent.appendChild(newBody);

  const out = new XMLSerializer().serializeToString(fb2);
  return out;
}

function downloadBlob(content, filename, type='application/octet-stream'){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

mergeBtn.addEventListener('click', ()=>{
  if(!loadedFb2s.length){ log('⚠ Нет загруженных файлов'); return; }
  setStatus('Объединяю...', true);
  log('ℹ Объединяю ' + loadedFb2s.length + ' книг(и)...');
  const bookTitles = [];
  for(let i=0; i<loadedFb2s.length; i++){
    const t = parseFB2(loadedFb2s[i].xml);
    const title = t.title || loadedFb2s[i].name || `Часть ${i+1}`;
    bookTitles.push(title);
    log(`✓ [${i+1}] "${title}" — ${t.bodies.length} раздел(ов)`);
  }
  const merged = buildMergedFB2(loadedFb2s);
  if(merged){
    const firstCover = loadedFb2s[0] && loadedFb2s[0].cover ? loadedFb2s[0].cover : null;
    let mergedTitle = '';
    if(bookTitles.length <= 3){
      mergedTitle = bookTitles.join(' + ');
    } else {
      mergedTitle = bookTitles.slice(0, 2).join(' + ') + ` (+${bookTitles.length - 2})`;
    }
    window._lastMerged = {xml:merged, title: mergedTitle, items: loadedFb2s.slice(), cover: firstCover, bookTitles};
    exportEpubBtn.disabled = false;
    log('✅ Готово — нажмите «Скачать EPUB»');
    setStatus('Объединено ✓');
  } else {
    log('✗ Ошибка объединения');
    setStatus('Ошибка');
  }
});

async function createEpubFromFB2(xmlText, filename='book.epub'){
  const parsed = parseFB2(xmlText);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`);

  const oebps = zip.folder('OEBPS');
  const xhtmlFolder = oebps.folder('xhtml');
  // create simple chapter
  let manifestItems = [];
  let spineItems = [];
  let idx = 1;
  for(const bodyHtml of parsed.bodies){
    const name = `chapter${idx}.xhtml`;
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(parsed.title)} - ${idx}</title></head>\n<body>${bodyHtml}</body>\n</html>`;
    xhtmlFolder.file(name, xhtml);
    manifestItems.push(`<item id="item${idx}" href="xhtml/${name}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="item${idx}" />`);
    idx++;
  }

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(parsed.title)}</dc:title>\n    <dc:language>ru</dc:language>\n    <dc:identifier id="uid">id:merged</dc:identifier>\n  </metadata>\n  <manifest>\n    ${manifestItems.join('\n    ')}\n  </manifest>\n  <spine toc="ncx">\n    ${spineItems.join('\n    ')}\n  </spine>\n</package>`;

  oebps.file('content.opf', contentOpf);
  const blob = await zip.generateAsync({type:'blob', mimeType:'application/epub+zip'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function escapeXml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

exportEpubBtn.addEventListener('click', async ()=>{
  const v = window._lastMerged;
  if(!v){ log('⚠ Сначала объедините книги'); return; }
  log('ℹ Генерирую EPUB...');
  setStatus('Создаю EPUB...', true);
  exportEpubBtn.disabled = true;
  try{
    const safeFilename = (v.title || 'merged').replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ') + '.epub';
    await createEpubFromMerged(v, safeFilename);
    log('✅ EPUB скачан!');
    setStatus('EPUB готов ✓');
  } catch(e){
    log('✗ Ошибка: ' + (e.message||e));
    setStatus('Ошибка');
  } finally {
    exportEpubBtn.disabled = false;
  }
});

function getFormatBadge(filename){
  const n = filename.toLowerCase();
  if(n.endsWith('.fb2') || n.endsWith('.fb2.zip')) return {label:'FB2',  cls:'fmt-fb2'};
  if(n.endsWith('.epub'))  return {label:'EPUB', cls:'fmt-epub'};
  if(n.endsWith('.mobi'))  return {label:'MOBI', cls:'fmt-mobi'};
  if(n.endsWith('.zip'))   return {label:'ZIP',  cls:'fmt-zip'};
  return {label:'TXT', cls:'fmt-other'};
}

function renderFilesList(){
  filesListEl.innerHTML = '';

  if(!loadedFb2s.length){
    filesSection.classList.add('hidden');
    actionsSection.classList.add('hidden');
    return;
  }

  filesSection.classList.remove('hidden');
  actionsSection.classList.remove('hidden');
  fileCountEl.textContent = loadedFb2s.length + (loadedFb2s.length === 1 ? ' файл' : loadedFb2s.length < 5 ? ' файла' : ' файлов');

  loadedFb2s.forEach((it, idx) => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.setAttribute('role','listitem');
    div.style.animationDelay = (idx * 0.04) + 's';

    // Format badge
    const fmt = getFormatBadge(it.name);
    const badge = document.createElement('span');
    badge.className = 'file-fmt-badge ' + fmt.cls;
    badge.textContent = fmt.label;

    // Filename
    const name = document.createElement('span');
    name.className = 'file-name';
    name.title = it.name;
    name.textContent = it.name;

    // Cover tag
    if(it.cover){
      const tag = document.createElement('span');
      tag.className = 'file-cover-tag';
      tag.textContent = 'обложка';
      div.appendChild(badge);
      div.appendChild(name);
      div.appendChild(tag);
    } else {
      div.appendChild(badge);
      div.appendChild(name);
    }

    // Order buttons
    const btns = document.createElement('div');
    btns.className = 'file-order-btns';

    const up = document.createElement('button');
    up.className = 'order-btn';
    up.textContent = '▲';
    up.title = 'Переместить выше';
    up.disabled = idx === 0;
    up.addEventListener('click', () => {
      if(idx > 0){
        [loadedFb2s[idx-1], loadedFb2s[idx]] = [loadedFb2s[idx], loadedFb2s[idx-1]];
        renderFilesList();
      }
    });

    const down = document.createElement('button');
    down.className = 'order-btn';
    down.textContent = '▼';
    down.title = 'Переместить ниже';
    down.disabled = idx === loadedFb2s.length - 1;
    down.addEventListener('click', () => {
      if(idx < loadedFb2s.length - 1){
        [loadedFb2s[idx+1], loadedFb2s[idx]] = [loadedFb2s[idx], loadedFb2s[idx+1]];
        renderFilesList();
      }
    });

    btns.appendChild(up);
    btns.appendChild(down);
    div.appendChild(btns);
    filesListEl.appendChild(div);
  });
}

async function createEpubFromMerged(mergedObj, filename='book.epub'){
  const items = mergedObj.items || [];
  const title = mergedObj.title || 'Merged Book';
  const bookTitles = mergedObj.bookTitles || [];
  const description = bookTitles.length > 0 ? `Объединённая книга: ${bookTitles.join('; ')}` : 'Объединённая книга';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
  zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`);

  const oebps = zip.folder('OEBPS');
  const xhtmlFolder = oebps.folder('xhtml');
  oebps.folder('images');

  let manifest = [];
  let spine = [];
  let tocNav = [];
  let fileIdx = 0;
  let playOrder = 0;

  // add cover if present
  if(mergedObj.cover){
    const cov = mergedObj.cover;
    const covData = await blobToArrayBuffer(cov.blob);
    const ext = mimeToExt(cov.type);
    oebps.folder('images').file(`cover.${ext}`, covData);
    manifest.push(`<item id="cover-image" href="images/cover.${ext}" media-type="${cov.type}"/>`);
    const coverXHtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>Cover</title></head>\n<body><div style="text-align:center;"><img src="../images/cover.${ext}" alt="Cover"/></div></body>\n</html>`;
    xhtmlFolder.file('cover.xhtml', coverXHtml);
    manifest.push(`<item id="coverpage" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="coverpage" />`);
    playOrder++;
  }

  // create TOC page
  let tocHtml = '<h1>Содержание</h1><ol>';
  for(let i=0; i<items.length; i++){
    const parsed = parseFB2(items[i].xml);
    const safeTitle = (parsed.title || items[i].name || `Часть ${i+1}`).replace(/[<>"'&]/g,'');
    tocHtml += `<li><a href="book${i+1}.xhtml">${escapeHtml(safeTitle)}</a></li>`;
  }
  tocHtml += '</ol>';
  
  const tocXhtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>Содержание</title></head>\n<body>${tocHtml}</body>\n</html>`;
  fileIdx++;
  const tocId = `file${fileIdx}`;
  xhtmlFolder.file('toc_page.xhtml', tocXhtml);
  manifest.push(`<item id="${tocId}" href="xhtml/toc_page.xhtml" media-type="application/xhtml+xml"/>`);
  spine.push(`<itemref idref="${tocId}" />`);
  playOrder++;
  tocNav.push({id:tocId, title:'Содержание', href:'xhtml/toc_page.xhtml', playOrder, children:[]});

  // create chapters for each book with sections
  for(let bookIdx=0; bookIdx<items.length; bookIdx++){
    const it = items[bookIdx];
    const parsed = parseFB2(it.xml);
    const bookTitle = (parsed.title || it.name || `Часть ${bookIdx+1}`).replace(/[<>"'&]/g,'');
    
    const bookNavPoint = {id:`book${bookIdx+1}`, title:bookTitle, href:'', playOrder:playOrder++, children:[]};
    
    // each body with its sections
    for(let bodyIdx=0; bodyIdx<parsed.bodies.length; bodyIdx++){
      const sec = parsed.bodies[bodyIdx];
      const sectionTitle = sec.title || `${bookTitle} - ${bodyIdx+1}`;
      
      fileIdx++;
      const fileId = `file${fileIdx}`;
      const fileName = `book${bookIdx+1}_section${bodyIdx+1}.xhtml`;
      const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(sectionTitle)}</title></head>\n<body><h1>${escapeHtml(sectionTitle)}</h1>${sec.html}</body>\n</html>`;
      
      xhtmlFolder.file(fileName, xhtml);
      manifest.push(`<item id="${fileId}" href="xhtml/${fileName}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${fileId}" />`);
      
      bookNavPoint.children.push({id:fileId, title:sectionTitle, href:`xhtml/${fileName}`, playOrder:playOrder++});
      
      if(bodyIdx===0) bookNavPoint.href = `xhtml/${fileName}`;
    }
    
    tocNav.push(bookNavPoint);
  }

  // build NCX with hierarchy
  let ncxNavPoints = '';
  function buildNcx(navs, indent=0){
    for(let i=0; i<navs.length; i++){
      const n = navs[i];
      ncxNavPoints += `<navPoint id="navPoint-${n.playOrder}" playOrder="${n.playOrder}"><navLabel><text>${escapeXml(n.title)}</text></navLabel><content src="${n.href}"/>`;
      if(n.children && n.children.length > 0){
        ncxNavPoints += '<navMap>';
        buildNcx(n.children, indent+1);
        ncxNavPoints += '</navMap>';
      }
      ncxNavPoints += '</navPoint>\n';
    }
  }
  buildNcx(tocNav.slice(1)); // skip cover entry
  
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head>\n    <meta name="dtb:uid" content="id:merged"/>\n  </head>\n  <docTitle><text>${escapeXml(title)}</text></docTitle>\n  <navMap>\n    ${ncxNavPoints}\n  </navMap>\n</ncx>`;
  oebps.file('toc.ncx', ncx);
  manifest.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(title)}</dc:title>\n    <dc:language>ru</dc:language>\n    <dc:description>${escapeXml(description)}</dc:description>\n    <dc:identifier id="uid">id:merged-${Date.now()}</dc:identifier>\n    ${mergedObj.cover?'<meta name="cover" content="cover-image"/>':''}\n  </metadata>\n  <manifest>\n    ${manifest.join('\n    ')}\n  </manifest>\n  <spine toc="ncx">\n    ${spine.join('\n    ')}\n  </spine>\n</package>`;

  oebps.file('content.opf', contentOpf);

  const blob = await zip.generateAsync({type:'blob', mimeType:'application/epub+zip'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function blobToArrayBuffer(blob){ return new Response(blob).arrayBuffer(); }

// ─── MOBI / PalmDoc parser ───────────────────────────────────────────────────

async function processMobiArrayBuffer(arrayBuffer, fileName){
  const view = new DataView(arrayBuffer);

  // Verify PalmDB creator field (offset 64, 4 bytes) = 'MOBI'
  const creator = String.fromCharCode(
    view.getUint8(64), view.getUint8(65), view.getUint8(66), view.getUint8(67)
  );
  if(creator !== 'MOBI') throw new Error('Не MOBI файл (creator: ' + creator + ')');

  // Number of PalmDB records at offset 76
  const numRecords = view.getUint16(76, false);
  const records = [];
  for(let i = 0; i < numRecords; i++){
    const offset = view.getUint32(78 + i * 8, false);
    const nextOffset = i < numRecords - 1
      ? view.getUint32(78 + (i + 1) * 8, false)
      : arrayBuffer.byteLength;
    records.push({offset, length: nextOffset - offset});
  }
  if(!records.length) throw new Error('Нет записей в PalmDB');

  const r0 = records[0];

  // PalmDoc header (first 16 bytes of record 0)
  const compression   = view.getUint16(r0.offset,     false); // 1=none, 2=PalmDoc, 17480=Huffman
  const textRecCount  = view.getUint16(r0.offset + 8, false);

  // MOBI header starts at byte 16 of record 0
  const mobiMagic = String.fromCharCode(
    view.getUint8(r0.offset+16), view.getUint8(r0.offset+17),
    view.getUint8(r0.offset+18), view.getUint8(r0.offset+19)
  );
  if(mobiMagic !== 'MOBI') throw new Error('Не найден MOBI заголовок');

  const mobiHeaderLen = view.getUint32(r0.offset + 20, false);
  const rawEncoding   = view.getUint32(r0.offset + 28, false); // 1252 or 65001
  const enc = rawEncoding === 65001 ? 'utf-8' : 'windows-1252';

  // Book title from MOBI full-name field
  let title = fileName.replace(/\.[^.]+$/, '');
  if(mobiHeaderLen >= 88){
    const nameOff = view.getUint32(r0.offset + 84, false);
    const nameLen = view.getUint32(r0.offset + 88, false);
    if(nameOff + nameLen <= r0.length){
      try{
        const nameBytes = new Uint8Array(arrayBuffer, r0.offset + nameOff, nameLen);
        title = new TextDecoder(enc).decode(nameBytes).trim() || title;
      }catch(e){}
    }
  }

  // Extra-data flags — trailing bytes appended to each text record (MOBI 8+)
  let extraDataFlags = 0;
  if(mobiHeaderLen >= 228){
    extraDataFlags = view.getUint16(r0.offset + 242, false);
  }

  if(compression === 17480){
    throw new Error(
      'Huffman/CDIC сжатие (KF8/AZW) не поддерживается в браузере. '
    + 'Конвертируйте файл в EPUB через Calibre на компьютере, затем загрузите EPUB.'
    );
  }

  // Decompress text records (indices 1..textRecCount)
  const chunks = [];
  for(let i = 1; i <= textRecCount && i < records.length; i++){
    const rec = records[i];
    let data = new Uint8Array(arrayBuffer, rec.offset, rec.length);
    let len = data.length;
    if(extraDataFlags) len = mobiStripExtraData(data, extraDataFlags);
    data = data.slice(0, len);
    chunks.push(compression === 2 ? palmDocDecompress(data) : data);
  }

  // Concatenate all decompressed chunks
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for(const c of chunks){ combined.set(c, pos); pos += c.length; }

  let html = new TextDecoder(enc).decode(combined);

  // Clean up MOBI-specific tags
  html = html
    .replace(/<mbp:pagebreak[^>]*\/?>/gi, '<hr/>')
    .replace(/(<a\b[^>]*)filepos=\d+([^>]*>)/gi, '$1$2')
    .replace(/<img[^>]*recindex="[^"]*"[^>]*\/?>/gi, '');

  const xml = `<?xml version="1.0"?><FictionBook><description><title-info><book-title>${escapeXml(title)}</book-title></title-info></description><body>${html}</body></FictionBook>`;
  return {name: fileName, xml, binaries: new Map(), cover: null};
}

// Strip trailing extra data from a MOBI text record
function mobiStripExtraData(data, flags){
  let size = data.length;
  let f = flags >> 1;
  while(f){
    if(f & 1){
      let sz = 0, shift = 0, p = size - 1;
      for(let k = 0; k < 4 && p >= 0; k++, p--){
        const b = data[p];
        sz |= (b & 0x7f) << shift;
        shift += 7;
        if(!(b & 0x80)) break;
      }
      size -= sz;
    }
    f >>= 1;
  }
  if(flags & 1) size -= (data[size - 1] & 0x3) + 1;
  return Math.max(0, size);
}

// PalmDoc (LZ77 variant) decompression
function palmDocDecompress(data){
  const out = [];
  let i = 0;
  while(i < data.length){
    const b = data[i++];
    if(b === 0x00){
      out.push(0);
    } else if(b < 0x09){
      // literal run of b bytes
      const end = Math.min(i + b, data.length);
      while(i < end) out.push(data[i++]);
    } else if(b < 0x80){
      // literal byte
      out.push(b);
    } else if(b < 0xC0){
      // 2-byte back-reference
      const next = data[i++] || 0;
      const dist = ((b << 8 | next) >> 3) & 0x7ff;
      const len  = (next & 0x07) + 3;
      const base = out.length - dist;
      for(let j = 0; j < len; j++){
        out.push(base + j >= 0 ? (out[base + j] || 0x20) : 0x20);
      }
    } else {
      // space + char (0xC0-0xFF)
      out.push(0x20);
      out.push(b ^ 0x80);
    }
  }
  return new Uint8Array(out);
}

// ── Service Worker Registration for PWA ────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('ServiceWorker registered successfully with scope: ', reg.scope);
      })
      .catch((err) => {
        console.error('ServiceWorker registration failed: ', err);
      });
  });
}
