"""Validate a local PDF/DOCX upload and create its searchable document index."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile
import pdfplumber

folder = pathlib.Path(sys.argv[1]).resolve()
doc_id, display_name, extension = sys.argv[2:5]
original = folder / ('original' + extension)
pdf_path = folder / 'document.pdf'
def libreoffice_command():
    configured = os.environ.get('LEASE_SOFFICE')
    if configured:
        return configured
    found = shutil.which('soffice') or shutil.which('libreoffice')
    if found:
        return found
    candidates = [pathlib.Path('/Applications/LibreOffice.app/Contents/MacOS/soffice')]
    for key in ('PROGRAMFILES', 'PROGRAMFILES(X86)'):
        if os.environ.get(key):
            candidates.append(pathlib.Path(os.environ[key]) / 'LibreOffice/program/soffice.exe')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise ValueError('DOCX uploads require LibreOffice. Install it or set LEASE_SOFFICE to the soffice executable.')

if extension == '.docx':
    with zipfile.ZipFile(original) as z:
        members = z.infolist()
        if len(members) > 5000 or sum(x.file_size for x in members) > 100 * 1024 * 1024:
            raise ValueError('DOCX archive is too large when expanded.')
        names = {x.filename for x in members}
        if not {'[Content_Types].xml', 'word/document.xml'}.issubset(names):
            raise ValueError('The file is not a Word DOCX document.')
        if any(x.flag_bits & 1 for x in members):
            raise ValueError('Encrypted DOCX files are not supported.')
    env = dict(os.environ)
    env['XDG_CACHE_HOME'] = str(folder / 'cache')
    result = subprocess.run([libreoffice_command(), '-env:UserInstallation=' + (folder / 'libreoffice-profile').as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(folder), str(original)], capture_output=True, text=True, timeout=150, env=env)
    converted = folder / 'original.pdf'
    if result.returncode or not converted.exists():
        raise ValueError('LibreOffice could not convert this DOCX to PDF.')
    converted.replace(pdf_path)
else:
    if not original.read_bytes().startswith(b'%PDF-'):
        raise ValueError('The file does not have a PDF header.')
    pdf_path.write_bytes(original.read_bytes())

pages = []
with pdfplumber.open(pdf_path) as pdf:
    if not 1 <= len(pdf.pages) <= 800:
        raise ValueError('PDF must contain between 1 and 800 pages.')
    total_words = 0
    for i, page in enumerate(pdf.pages, 1):
        words = [{'text': w['text'], 'x0': round(w['x0'], 2), 'y0': round(w['top'], 2),
                  'x1': round(w['x1'], 2), 'y1': round(w['bottom'], 2)}
                 for w in page.extract_words(x_tolerance=2, y_tolerance=3)]
        total_words += len(words)
        if total_words > 1000000:
            raise ValueError('Document contains too much text for a single upload.')
        pages.append({'page': i, 'width': round(page.width, 2), 'height': round(page.height, 2),
                      'text': page.extract_text(x_tolerance=2, y_tolerance=3) or '', 'words': words})

base_url = '/documents/uploads/' + doc_id
doc = {'id': doc_id, 'title': pathlib.Path(display_name).stem, 'kind': 'uploaded-document',
       'category': 'uploaded', 'sourceFilename': display_name,
       'sourceUrl': base_url + '/original' + extension,
       'originalUrl': base_url + '/original' + extension, 'pdfUrl': base_url + '/document.pdf',
       'pageCount': len(pages), 'status': 'awaiting_extraction',
       'sourceSha256': hashlib.sha256(original.read_bytes()).hexdigest(),
       'pdfSha256': hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
       'textAvailable': any(p['text'].strip() for p in pages), 'pages': pages}
if not doc['textAvailable']:
    doc['warning'] = 'No embedded text was found. This scan requires OCR before text evidence can be imported.'
(folder / 'document.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
print(json.dumps({'id': doc_id, 'pageCount': len(pages), 'textAvailable': doc['textAvailable']}))
