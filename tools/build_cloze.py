#!/usr/bin/env python3
"""Build data/cloze.json from tools/material/cloze.txt  (短文克漏字 + 單句克漏字).

  python3 tools/build_cloze.py

cloze.txt format
  # comment lines and blank lines outside a passage are ignored
  @bank 龍騰                       (which word bank these questions belong to — the name must match one in words.txt;
                                    run build_words.py first. Each bank has its own cloze questions and its own switch.)
  @sample 說明文字                 (optional, right after @bank: marks that bank's cloze questions as demo data)
  @unit 3                          (following items belong to unit 3 of that bank; a display name may follow the number,
                                    e.g. @unit 6.5 Review 2 — it is defined in words.txt, here the number is what counts)

  單句 (one line):  S | sentence with ______ | A選項 | B選項 | C選項 | D選項 | 答案字母 | 解析(可省略)

  短文 (several lines):
  @passage 標題(可省略)
  Tom woke up late [1] morning. He [2] to school ...      ← blanks are written [1] [2] [3] …
  (a blank line starts a new paragraph)
  1 | A選項 | B選項 | C選項 | D選項 | 答案字母 | 解析(可省略)
  2 | …
  @end

Checks (any failure aborts the build): exactly one ______ per sentence; 4 distinct options; answer letter is A–D;
every [n] in a passage appears once and has an option line, and every option line has a matching [n].
Item ids come from bank + unit + order of appearance (b1-p3-1 = bank 1, unit 3, 1st passage; b1-s3-2 = its 2nd sentence):
to keep students' progress, only ever ADD new items at the END of a unit (and new banks at the end of the file).
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'material' / 'cloze.txt'
OUT = ROOT / 'data' / 'cloze.json'
WORDS = ROOT / 'data' / 'words.json'
BLANK = '______'


def ukey(u):  # unit number as used inside ids: 6.5 -> 6_5
    return f'{u:g}'.replace('.', '_')


def parse_opts(f, n, tag, errors):
    """f = [A, B, C, D, letter, (exp)] → (opts, ans, exp) or None"""
    if len(f) < 5: errors.append(f'{n}: {tag} 欄位不足 (需要 4 個選項 + 答案字母)'); return None
    opts, letter, exp = f[:4], f[4].upper(), (f[5] if len(f) > 5 else '')
    if not all(opts): errors.append(f'{n}: {tag} 有空白的選項'); return None
    if len({o.lower() for o in opts}) != 4: errors.append(f'{n}: {tag} 選項重複')
    if letter not in ('A', 'B', 'C', 'D'): errors.append(f'{n}: {tag} 答案字母必須是 A–D (目前是 "{f[4]}")'); return None
    return opts, opts['ABCD'.index(letter)], exp


def main():
    lines = SRC.read_text(encoding='utf-8').splitlines()
    meta, passages, sentences, errors = {'banks': {}}, [], [], []
    unit, pcount, scount, i, bank = None, {}, {}, 0, None
    names = {b['name']: b['id'] for b in json.loads(WORDS.read_text(encoding='utf-8'))['meta'].get('banks', [])} if WORDS.exists() else {}
    while i < len(lines):
        n, line = i + 1, lines[i].strip(); i += 1
        if not line or line.startswith('#'): continue
        if line.startswith('@unit'):
            v = line[5:].strip().split(None, 1)[0] if line[5:].strip() else ''  # an optional display name after the number is read by build_words.py
            if re.fullmatch(r'\d+(?:\.\d+)?', v): unit = float(v) if '.' in v else int(v)
            else: errors.append(f'{n}: @unit 後面要接數字')
        elif line.startswith('@bank'):
            nm = line[5:].strip()
            if nm not in names: errors.append(f'{n}: 找不到單字庫「{nm}」(words.txt 裡要有同名的 @bank)'); bank = None
            else: bank = names[nm]; meta['banks'].setdefault(bank, {}); unit = None
        elif line.startswith('@sample'):
            if bank: meta['banks'][bank]['sample'] = True; meta['banks'][bank]['note'] = line[7:].strip()
            else: errors.append(f'{n}: @sample 要寫在 @bank 之後')
        elif line.startswith('@source'):
            meta['source'] = line[7:].strip()
        elif line.startswith('@passage'):
            title = line[8:].strip()
            if bank is None: errors.append(f'{n}: 短文之前要先寫 @bank 名稱')
            if unit is None: errors.append(f'{n}: 短文之前要先寫 @unit N')
            text, blanks, start = [], {}, n
            while i < len(lines) and lines[i].strip() != '@end':
                raw = lines[i].rstrip(); m = re.match(r'^\s*(\d+)\s*\|(.*)$', raw)
                if m: # option line
                    no = int(m.group(1))
                    r = parse_opts([x.strip() for x in m.group(2).split('|')], i + 1, f'短文第 {no} 格', errors)
                    if no in blanks: errors.append(f'{i + 1}: 第 {no} 格的選項寫了兩次')
                    elif r: blanks[no] = r
                else:
                    text.append(raw)
                i += 1
            if i >= len(lines): errors.append(f'{start}: @passage 沒有對應的 @end'); break
            i += 1  # skip @end
            # lines → paragraphs (blank line = new paragraph, other line breaks become spaces)
            paras = [' '.join(p.split()) for p in re.split(r'\n\s*\n', '\n'.join(text).strip())]
            body = '\n\n'.join(p for p in paras if p)
            marks = [int(x) for x in re.findall(r'\[(\d+)\]', body)]
            if len(set(marks)) != len(marks): errors.append(f'{start}: 短文裡有重複的空格編號')
            if sorted(set(marks)) != sorted(blanks): errors.append(f'{start}: 短文空格 {sorted(set(marks))} 與選項行 {sorted(blanks)} 不一致')
            if unit is None or bank is None: continue
            pk = (bank, unit); pcount[pk] = pcount.get(pk, 0) + 1
            passages.append({'id': f'{bank}-p{ukey(unit)}-{pcount[pk]}', 'bank': bank, 'unit': unit, 'no': pcount[pk], 'title': title, 'text': body,
                             'blanks': [{'no': k, 'opts': blanks[k][0], 'ans': blanks[k][1], **({'exp': blanks[k][2]} if blanks[k][2] else {})} for k in sorted(blanks)]})
        elif line.startswith('S') and line[1:].lstrip().startswith('|'):
            f = [x.strip() for x in line.split('|')][1:]
            if bank is None: errors.append(f'{n}: 單句之前要先寫 @bank 名稱'); continue
            if unit is None: errors.append(f'{n}: 單句之前要先寫 @unit N'); continue
            if not f: errors.append(f'{n}: 單句是空的'); continue
            sent = f[0]
            if sent.count(BLANK) != 1: errors.append(f'{n}: 單句要剛好一個 {BLANK}: {sent[:40]}')
            r = parse_opts(f[1:], n, '單句', errors)
            if not r or sent.count(BLANK) != 1: continue
            sk = (bank, unit); scount[sk] = scount.get(sk, 0) + 1
            s = {'id': f'{bank}-s{ukey(unit)}-{scount[sk]}', 'bank': bank, 'unit': unit, 'no': scount[sk], 'q': sent, 'full': sent.replace(BLANK, r[1], 1), 'opts': r[0], 'ans': r[1]}
            if r[2]: s['exp'] = r[2]
            sentences.append(s)
        else:
            errors.append(f'{n}: 看不懂這一行: {line[:50]}')
    if errors:
        print('\n'.join(errors)); sys.exit(1)
    meta['passages'] = len(passages); meta['blanks'] = sum(len(p['blanks']) for p in passages); meta['sentences'] = len(sentences)
    OUT.write_text(json.dumps({'meta': meta, 'passages': passages, 'sentences': sentences}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"OK: {len(passages)} 篇短文 ({meta['blanks']} 格) + {len(sentences)} 個單句 → {OUT.relative_to(ROOT)}")


if __name__ == '__main__':
    main()
