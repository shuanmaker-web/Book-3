#!/usr/bin/env python3
"""Build data/cloze.json from tools/material/cloze.txt  (短文克漏字 + 單句克漏字).

  python3 tools/build_cloze.py

cloze.txt format
  # comment lines and blank lines outside a passage are ignored
  @sample 說明文字                 (optional: marks the file as demo data)
  @source 教材名稱                  (optional)
  @unit 3                          (following items belong to unit 3)

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
Item ids come from unit + order of appearance (p3-1 = unit 3's 1st passage, s3-2 = unit 3's 2nd sentence):
to keep students' progress, only ever ADD new items at the END of a unit.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'material' / 'cloze.txt'
OUT = ROOT / 'data' / 'cloze.json'
BLANK = '______'


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
    meta, passages, sentences, errors = {}, [], [], []
    unit, pcount, scount, i = None, {}, {}, 0
    while i < len(lines):
        n, line = i + 1, lines[i].strip(); i += 1
        if not line or line.startswith('#'): continue
        if line.startswith('@unit'):
            v = line[5:].strip()
            if v.isdigit(): unit = int(v)
            else: errors.append(f'{n}: @unit 後面要接數字')
        elif line.startswith('@sample'):
            meta['sample'] = True; meta['note'] = line[7:].strip()
        elif line.startswith('@source'):
            meta['source'] = line[7:].strip()
        elif line.startswith('@passage'):
            title = line[8:].strip()
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
            if unit is None: continue
            pcount[unit] = pcount.get(unit, 0) + 1
            passages.append({'id': f'p{unit}-{pcount[unit]}', 'unit': unit, 'no': pcount[unit], 'title': title, 'text': body,
                             'blanks': [{'no': k, 'opts': blanks[k][0], 'ans': blanks[k][1], **({'exp': blanks[k][2]} if blanks[k][2] else {})} for k in sorted(blanks)]})
        elif line.startswith('S') and line[1:].lstrip().startswith('|'):
            f = [x.strip() for x in line.split('|')][1:]
            if unit is None: errors.append(f'{n}: 單句之前要先寫 @unit N'); continue
            if not f: errors.append(f'{n}: 單句是空的'); continue
            sent = f[0]
            if sent.count(BLANK) != 1: errors.append(f'{n}: 單句要剛好一個 {BLANK}: {sent[:40]}')
            r = parse_opts(f[1:], n, '單句', errors)
            if not r or sent.count(BLANK) != 1: continue
            scount[unit] = scount.get(unit, 0) + 1
            s = {'id': f's{unit}-{scount[unit]}', 'unit': unit, 'no': scount[unit], 'q': sent, 'full': sent.replace(BLANK, r[1], 1), 'opts': r[0], 'ans': r[1]}
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
