#!/usr/bin/env python3
"""Build data/words.json from tools/material/words.txt  (one word per line, fields separated by |).

  python3 tools/build_words.py

words.txt format
  # comment lines and blank lines are ignored
  @title 書名或 App 標題             (optional)
  @source 教材名稱                    (optional, shown in 設定 > 關於)
  @unitword Unit                      (optional: what a unit is called — Unit / Lesson / 第幾課 …)
  @sample 說明文字                    (optional: marks the file as demo data; a banner is shown in the app)
  @bank 名稱                          (optional: start a new word bank, e.g. a second textbook. The app then shows a switch
                                       on the home page; progress, unit range and new-word order are kept per bank.
                                       Words before the first @bank — or a file with no @bank — form one bank.)
  @unit 3                             (all following words belong to unit 3; unit numbers restart in each bank)
  word | pos | 中文意思 | example sentence (optional) | 例句中文 (optional)

Word ids are made from the bank number + the word itself (so reordering the file never mixes up students' progress; the same
word may appear in two banks). Two entries with the same spelling in ONE bank must differ in pos, otherwise the build stops.
To keep progress, never reorder or delete @bank blocks — add new banks at the END of the file.
Checks: every line has word/pos/中文; no duplicated id; unit declared before the first word.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'material' / 'words.txt'
OUT = ROOT / 'data' / 'words.json'


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def main():
    meta, words, errors, unit, seen, banks = {}, [], [], None, {}, []
    for n, raw in enumerate(SRC.read_text(encoding='utf-8').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            key, _, val = line[1:].partition(' ')
            val = val.strip()
            if key == 'bank':
                if not val: errors.append(f'{n}: @bank 後面要接名稱'); continue
                banks.append({'id': f'b{len(banks) + 1}', 'name': val}); unit = None
            elif key == 'unit':
                if not val.isdigit(): errors.append(f'{n}: @unit 後面要接數字'); continue
                unit = int(val)
            elif key in ('title', 'source', 'unitword', 'note'):
                meta['unitWord' if key == 'unitword' else key] = val
            elif key == 'sample':
                meta['sample'] = True; meta['note'] = val
            else:
                errors.append(f'{n}: 不認得的指令 @{key}')
            continue
        f = [x.strip() for x in line.split('|')]
        if len(f) < 3 or not all(f[:3]):
            errors.append(f'{n}: 至少要有 單字 | 詞性 | 中文: {line[:50]}'); continue
        if unit is None: errors.append(f'{n}: 第一個單字之前要先寫 @unit N'); continue
        w, pos, zh = f[0], f[1], f[2]
        ex = f[3] if len(f) > 3 else ''
        exzh = f[4] if len(f) > 4 else ''
        if not banks: banks.append({'id': 'b1', 'name': meta.get('title', '單字')})
        bid = banks[-1]['id']
        wid = f'{bid}-{slug(w) or "w" + str(n)}'
        if wid in seen:
            wid = f'{wid}-{slug(pos)}'
        if wid in seen:
            errors.append(f'{n}: 單字重複 "{w}" (第 {seen[wid]} 行)'); continue
        seen[wid] = n
        item = {'id': wid, 'bank': bid, 'w': w, 'pos': pos, 'zh': zh, 'unit': unit}
        if ex: item['ex'] = ex
        if exzh: item['exzh'] = exzh
        words.append(item)
    if errors:
        print('\n'.join(errors)); sys.exit(1)
    units = sorted({w['unit'] for w in words})
    meta['words'] = len(words); meta['units'] = units; meta['banks'] = banks
    OUT.write_text(json.dumps({'meta': meta, 'words': words}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'OK: {len(words)} 個單字 / {len(banks)} 個單字庫 / 單元 {units} → {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
