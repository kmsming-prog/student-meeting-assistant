# AI 協作說明

先讀 [README.md](README.md) 和 [部署與試跑](docs/deployment.md)。這是可在 Cloudflare Workers 上自行部署的 LINE 預約範本。請使用同仁自己的帳號、日曆與 D1，依對方提供的規則調整程式。

## 先確認的設定

- 可預約的星期、時段、晤談長度、時區和日期範圍。時間與候選時段的共用邏輯在 `src/time.mjs`。修改長度或範圍時，同步核對 LINE 文案及測試。若改時區，日期、星期、日曆查詢和用量月份皆須一起驗證。
- LINE 好友是目前的一般預約對象。固定學生的登記與日曆系列對應在 `MEETING_PROFILE`，欄位格式見 `calendar-profile.example.json`。
- 要寫入的日曆和另外要比對忙碌的日曆。老師協助通知須先完成老師 LINE 帳號綁定。
- 撞期及無空檔時的通知對象、文案、人工處理方式和每月推播用量。

## 程式入口

| 檔案 | 用途 |
| --- | --- |
| `src/worker.mjs` | LINE 和 Calendar Webhook、管理端點、排程 |
| `src/bookings.mjs`、`src/registration.mjs`、`src/line.mjs` | 預約、姓名登記、LINE 回覆及圖文卡片 |
| `src/conflicts.mjs`、`src/calendar-watch.mjs` | 衝突監控與重新預約 |
| `src/time.mjs`、`src/google.mjs` | 時段規則、日曆查詢及事件寫入 |
| `src/store.mjs`、`migrations/` | D1 狀態、通知及稽核紀錄 |
| `scripts/admin.mjs`、`assets/booking-menu.png` | 管理指令及 LINE 選單素材 |

## 驗證與部署

- 使用 `npm test` 驗證。確認預約前的重查、同時預約、按鈕重送、不同帳號的資料隔離，以及固定晤談只改單次事件。
- 個人的 LINE 憑證、日曆設定和金鑰使用部署環境的 Secrets。測試和版本庫使用假資料。
- 使用獨立 Worker、D1 與測試日曆試跑，核對 LINE 與 Google 日曆結果後，再依帳號持有人的指示上線。
