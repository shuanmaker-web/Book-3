# 單字特訓(working title)

給單一學生使用的英文單字 PWA(手機優先)。由 Vocaboo 分支出來,但**完全獨立**:自己的 repo、自己的網址、自己的
IndexedDB(`vocab-student-v1`)與 Service Worker 快取(`vstu-*`),不會動到 Vocaboo / Vocabee 的資料。

## 學習形式
- **單字學習**:只有 **選擇題** 與 **拼字**(FSRS 排程,各自一套卡片)。新字依教材順序出現,兩種模式同一批字、同一順序;
  只做過其中一種的字,另一種會先重做那一批。「已學」= 選擇題與拼字都答過。
- **克漏字**(分頁):
  - **短文克漏字**:整篇短文,每個空格一題(4 選 1);目前的空格會標示,已作答的空格自動填入答案。
  - **單句克漏字**:一句一個空格(4 選 1)。
  - 依單元分組、可只重測錯題、可「繼續作答」,進度自動保存;分頁上方可切換 全部 / 短文 / 單句。

## 資料怎麼更新(不用寫程式)
教材內容放在 `tools/material/` 兩個純文字檔,改完執行對應的 build script 即可產生 `data/*.json`:

| 檔案 | 產生 | 指令 |
|---|---|---|
| `tools/material/words.txt` | `data/words.json` | `python3 tools/build_words.py` |
| `tools/material/cloze.txt` | `data/cloze.json` | `python3 tools/build_cloze.py` |

兩個 script 的檔頭都有格式說明;建置時會檢查格式(欄位數、選項重複、答案字母、空格編號對不對…),有錯就停止並指出行號。

- 單字 id 由單字本身產生,所以調整順序不會弄亂學生進度。
- 克漏字 id 由「單元 + 出現順序」產生(`p3-1` = Unit 3 第 1 篇短文、`s3-2` = Unit 3 第 2 個單句):
  **想保留學生的作答紀錄,新題目請一律加在該單元的最後面**。
- 目前 `data/` 與 `tools/material/` 內是**示範資料**(App 內會顯示「示範資料」橫幅);換成正式內容後橫幅自動消失
  (刪掉檔頭的 `@sample` 那行)。

## 發佈流程(與 Vocaboo 相同)
1. 改檔 → 2. 學生會載入的檔案有變動就把 `sw.js` 的 `VERSION` 加一(`v1` → `v2` …),學生才會拿到新版 →
3. 本機用 `python3 -m http.server` + 手機尺寸瀏覽器實測 → 4. 經老師確認後 commit + push 到 `main`(GitHub Pages)。

所有資源路徑一律用相對路徑(網站放在 `/<repo>/` 子路徑下)。

## 備份
設定頁可匯出/匯入進度(檔案標記 `vocab-student`,與 Vocaboo 的備份檔互不相容,不會誤匯入)。

## 致謝
複習排程:[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)(MIT)。單字與題目內容整理自教材,僅供個人學習使用。
