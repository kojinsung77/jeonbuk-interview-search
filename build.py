"""Build an encrypted, multi-year interview library. No plaintext is published."""
from __future__ import annotations
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
from datetime import datetime, timezone
import tempfile
from collections import Counter

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import openpyxl
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
MAGIC = b'JBIS1'
ITERATIONS = 250_000

def pack(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

def read_json(path, fallback=None):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else fallback

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.writing-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(name, path)
    finally:
        if Path(name).exists():
            Path(name).unlink()

def key_for(password, salt):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                      iterations=ITERATIONS).derive(password.encode('utf-8'))

def encrypt(key, raw, label):
    iv = os.urandom(12)
    return MAGIC + iv + AESGCM(key).encrypt(iv, raw, (MAGIC.decode()+':'+label).encode())

def decrypt(key, raw, label):
    if raw[:5] != MAGIC:
        raise ValueError('Unknown encrypted file format')
    return AESGCM(key).decrypt(raw[5:17], raw[17:], (MAGIC.decode()+':'+label).encode())

def span(value):
    numbers = [int(n) for n in re.findall(r'\d+', str(value or ''))]
    return [numbers[0], numbers[-1]] if numbers else []

# Direct identifiers only; never rewrite the substance of student recollections.
PRIVATE_PATTERNS = [
    re.compile(r'(?<!\d)01[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)'),
    re.compile(r'(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)'),
    re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
    re.compile(r'(?:학생\s*이름|성명|출신\s*학교|연락처)\s*[:：]\s*[^\n,;]+'),
]

def sanitize(value, counts):
    if isinstance(value, str):
        for pattern in PRIVATE_PATTERNS:
            value, n = pattern.subn('[개인정보 삭제]', value)
            counts['redactions'] += n
        return value
    if isinstance(value, list):
        return [sanitize(v, counts) for v in value]
    if isinstance(value, dict):
        return {k: sanitize(v, counts) for k, v in value.items()}
    return value

def load_sources(source, years, cache):
    output, sources, used_details, ids = [], {}, set(), set()
    counts = Counter()
    for year in years:
        workbooks = sorted(source.glob(f'*/사례목록_{year}_전체.xlsx'))
        if not workbooks:
            raise ValueError(f'{year}: 사례목록_{year}_전체.xlsx 파일이 없습니다. 원본 PDF만으로는 빌드하지 않습니다.')
        if len(workbooks) != 1:
            raise ValueError(f'{year}: 전체목록 파일은 한 개만 두어 주세요.')
        book = workbooks[0]
        base = book.parent
        pdfs = {}
        for path in base.glob('사례별분할_*/*.pdf'):
            if path.name in pdfs:
                raise ValueError(f'중복 PDF 파일명: {path.name}')
            pdfs[path.name] = path
        details = {}
        for file in sorted((base / 'json').glob(f'{year}_*.json')):
            payload = read_json(file)
            for detail in payload['cases'] if isinstance(payload, dict) else payload:
                name = detail['pdf'].replace('\\', '/').split('/')[-1]
                if name in details:
                    raise ValueError(f'중복 문항 JSON: {name}')
                details[name] = detail
        wb = openpyxl.load_workbook(book, read_only=True, data_only=True)
        rows = iter(wb['전체목록'].values if '전체목록' in wb.sheetnames else wb.active.values)
        headers = [str(x or '').strip() for x in next(rows)]
        required = {'파일명', '연도', '계열', '대학', '학과', '전형', '원본PDF 쪽', '쪽수'}
        if not required.issubset(headers):
            raise ValueError(f'엑셀 열 누락: {required - set(headers)}')
        groups = Counter()
        seen_names = set()
        for row in rows:
            data = dict(zip(headers, row))
            name = str(data.get('파일명') or '').strip()
            if not name:
                continue
            if name in seen_names:
                raise ValueError(f'엑셀 중복: {name}')
            seen_names.add(name)
            if name not in pdfs:
                raise ValueError(f'PDF 없음: {name}')
            if int(data['연도']) != year:
                raise ValueError(f'연도 불일치: {name}')
            path = pdfs[name]
            group_slug = path.parent.name.removeprefix('사례별분할_')
            groups[group_slug] += 1
            source_key = f'{year}/{name}'
            old = cache.get('files', {}).get(source_key, {})
            detail = details.get(name, {})
            # File identity stays stable when JSON arrives or spreadsheet rows move.
            case_id = old.get('id') or f'{year}-' + hashlib.sha256(source_key.encode('utf-8')).hexdigest()[:16]
            if case_id in ids:
                raise ValueError(f'사례 ID 충돌: {case_id}')
            ids.add(case_id)
            case = {
                'id': case_id, 'year': year, 'group': str(data['계열']),
                'univ': str(data['대학']), 'dept': str(data['학과']),
                'admission': str(data.get('전형') or ''), 'pages': {'src': span(data['원본PDF 쪽']), 'book': []},
                'page_count': int(data['쪽수']), 'interview': {}, 'intro_note': '',
                'questions': [], 'etc': '', 'indexed': bool(detail),
            }
            if detail:
                for field in ['univ', 'dept', 'admission']:
                    if case[field] != detail.get(field):
                        raise ValueError(f'엑셀/JSON 불일치: {name} / {field}')
                for field in ['pages', 'interview', 'intro_note', 'questions', 'etc']:
                    if field in detail:
                        case[field] = detail[field]
                used_details.add(source_key)
            for field in ['interview', 'intro_note', 'questions', 'etc']:
                case[field] = sanitize(case[field], counts)
            sources[case_id] = (source_key, path)
            output.append(case)
        wb.close()
        unmatched = set(details) - seen_names
        if unmatched:
            raise ValueError(f'목록과 연결되지 않은 JSON: {sorted(unmatched)}')
    return output, sources, counts

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT.parent)
    parser.add_argument('--years', nargs='+', type=int, default=[2026])
    parser.add_argument('--password', nargs='?', const='prompt', default='prompt', help='값을 생략하면 숨김 입력')
    parser.add_argument('--verify', action='store_true', help='암호화된 모든 자료의 무결성 검사')
    args = parser.parse_args()
    password = getpass.getpass('App password: ') if args.password == 'prompt' else args.password
    if len(password) < 12:
        raise ValueError('비밀번호는 12자 이상으로 설정해 주세요.')
    public = ROOT / 'public'
    meta_path = public / 'data' / 'meta.json'
    cases_path = public / 'data' / 'cases.bin'
    cache_path = ROOT / '.build-cache.json'
    cache = read_json(cache_path, {})
    meta = read_json(meta_path, {})
    salt = base64.b64decode(meta['salt']) if meta else os.urandom(16)
    key = key_for(password, salt)
    if args.verify:
        payload = json.loads(decrypt(key, cases_path.read_bytes(), 'cases'))
        for case in payload['cases']:
            raw = decrypt(key, (public / case['pdf']).read_bytes(), case['pdf'])
            if not raw.startswith(b'%PDF-') or hashlib.sha256(raw).hexdigest() != case['sha256']:
                raise ValueError('PDF integrity failed: ' + case['id'])
        print(f"VERIFIED: {len(payload['cases'])} encrypted PDFs and case index")
        return
    reuse = False
    if cases_path.exists() and meta:
        try:
            decrypt(key, cases_path.read_bytes(), 'cases')
            reuse = True
        except Exception:
            salt = os.urandom(16)
            key = key_for(password, salt)
    cases, sources, counts = load_sources(args.source.resolve(), sorted(set(args.years)), cache)
    next_number = max([v.get('number', 0) for v in cache.get('files', {}).values()] + [0])
    new_cache = {'files': {}}
    reused = 0
    for case in cases:
        source_key, path = sources[case['id']]
        old = cache.get('files', {}).get(source_key, {})
        number = old.get('number')
        if number is None:
            next_number += 1
            number = next_number
        case['pdf'] = f'data/pdf/c{number:04d}.bin'
        target = public / case['pdf']
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        case['sha256'] = digest
        if reuse and old.get('sha256') == digest and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == old.get('cipher_sha256'):
            reused += 1
        else:
            reader = PdfReader(path)
            if len(reader.pages) != case['page_count']:
                raise ValueError(f'쪽수 불일치: {path.name}')
            # Image-only pages cannot be audited by a text scan. Record that honestly.
            for page in reader.pages:
                text = page.extract_text() or ''
                counts['image_only_pages' if len(text.strip()) < 20 else 'text_pages'] += 1
                if any(p.search(text) for p in PRIVATE_PATTERNS):
                    raise ValueError(f'PDF에서 개인정보 후보 발견. 원본을 검수/가림 처리하세요: {path.name}')
            atomic(target, encrypt(key, raw, case['pdf']))
        new_cache['files'][source_key] = {'id': case['id'], 'number': number, 'sha256': digest, 'cipher_sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    payload = {'schema_version': 1, 'built_at': datetime.now(timezone.utc).isoformat(),
               'source': '전북특별자치도교육청 면접사례모음집', 'cases': cases}
    atomic(cases_path, encrypt(key, pack(payload), 'cases'))
    atomic(meta_path, pack({'format': 'JBIS1', 'salt': base64.b64encode(salt).decode(),
                          'iterations': ITERATIONS, 'kdf': 'PBKDF2-SHA256', 'cipher': 'AES-256-GCM'}))
    atomic(cache_path, pack(new_cache))
    # Remove only obsolete generated ciphertext, never source files.
    keep = {Path(c['pdf']).name for c in cases}
    for path in (public / 'data' / 'pdf').glob('c*.bin'):
        if path.name not in keep:
            path.unlink()
    print(json.dumps({'cases': len(cases), 'indexed': sum(c['indexed'] for c in cases),
                      'questions': sum(len(c['questions']) for c in cases), 'universities': len(set(c['univ'] for c in cases)),
                      'years': sorted(set(c['year'] for c in cases)), 'pdf_reused': reused,
                      'privacy_scan': dict(counts)}, ensure_ascii=False))
    if counts['image_only_pages']:
        print('NOTE: image-only PDF pages require visual privacy review; text scanning does not verify them.')

if __name__ == '__main__':
    main()
